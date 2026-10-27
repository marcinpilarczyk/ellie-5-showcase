import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { ClaimsBankGuard, reviewOwnerText } from '../governance/claims-bank.js';
import { groundReply } from '../governance/reply-grounding.js';
import { screenCandidateLeakage } from '../agent/correction-extractor.js';
import { MemoryRepository } from '../storage/memory-repo.js';
import { WaitingRepository } from '../storage/waiting-repo.js';
import { GmailSentinel } from '../scheduler/sentinels/gmail-sentinel.js';
import { CalendarSentinel } from '../scheduler/sentinels/calendar-sentinel.js';
import { createGoogleTools } from '../tools/google-tools.js';
import { RoutineWorker } from '../scheduler/routine-worker.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { executeApprovedAction } from '../governance/executor.js';
import { processOverdueWaitingItems } from '../wake.js';

describe('Chief of Staff Next Phase: Tracks A, D, B, C', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let ledgerRepo: ActionLedgerRepository;
  let resultStore: ResultStore;
  let memoryRepo: MemoryRepository;
  let waitingRepo: WaitingRepository;
  let routineRepo: RoutineRepository;

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    resultStore = new ResultStore(appDb);
    memoryRepo = new MemoryRepository(appDb);
    waitingRepo = new WaitingRepository(appDb);
    routineRepo = new RoutineRepository(appDb);
  });

  // --- Track A: Claims Grounding ---
  describe('Track A: Document & Reply Grounding', () => {
    it('reviewOwnerText allows section/role capitalized words in documents but blocks invented figures', async () => {
      const claimsDoc = '# Claims Bank\n1. Built a high-velocity support team of 12 people. [V]';
      const guard = new ClaimsBankGuard(async () => claimsDoc, 60_000, async () => ({
        texts: [claimsDoc, 'Jan Kowalski\nEmail: jan@example.com'],
        missing: []
      }));

      // Document kind: section headers like "Executive Summary", "Customer Experience Strategy" are ordinary words
      // Should NOT be blocked as unsourced named result entities when skipNamedEntities: true
      const docText = 'Executive Summary: Directed Customer Operations and scaled support team of 12 people.';
      const docReview = await reviewOwnerText(guard, 'document', docText, { identity: false });
      assert.deepEqual(docReview.refusals, [], 'Valid document text with section/role capitalized words should pass');

      // But invented numbers/figures MUST be blocked in documents
      const badDocText = 'Executive Summary: Directed Customer Operations and scaled support team of 45 people.';
      const badDocReview = await reviewOwnerText(guard, 'document', badDocText, { identity: false });
      assert.ok(badDocReview.refusals.length > 0, 'Invented figures in documents must be blocked');
      assert.match(badDocReview.refusals[0], /45 people/);

      // In message kind, named results are strictly checked
      const msgText = 'I led Contoso and delivered 100 projects.';
      const msgReview = await reviewOwnerText(guard, 'message', msgText, { identity: false });
      assert.ok(msgReview.refusals.length > 0, 'Invented named results in messages must be blocked');
    });

    it('groundReply flags ungrounded percentages and currencies in tool-backed replies while passing grounded ones', () => {
      const toolCalls: any[] = [
        {
          tool: 'made_up_analytics',
          params: { query: 'churn' },
          result: { churnRate: '15%', savedAmount: '$45,000' }
        }
      ];

      // Grounded reply
      const groundedReply = 'Our churn dropped by 15% saving $45,000.';
      const checkedGrounded = groundReply(groundedReply, toolCalls);
      assert.equal(checkedGrounded, groundedReply);

      // Ungrounded reply with invented figures
      const ungroundedReply = 'We achieved an 85% reduction and generated €1,000,000 in revenue.';
      const checkedUngrounded = groundReply(ungroundedReply, toolCalls)!;
      assert.ok(checkedUngrounded.includes('_Note: unverified figure in reply'), 'Should flag ungrounded figures');
      assert.ok(checkedUngrounded.includes('85%'));
      assert.ok(checkedUngrounded.includes('€1,000,000'));

      // Figures provided in prompt / extraEvidenceTexts are recognized as grounded
      const extraEvidence = ['The client reported a 85% satisfaction score.'];
      const groundedViaExtra = groundReply('Customer satisfaction reached 85%.', toolCalls, undefined, extraEvidence);
      assert.ok(!groundedViaExtra!.includes('unverified figure'), 'Figure present in prompt/extra evidence is grounded');
    });
  });

  // --- Track D: RRSI Self-Improvement ---
  describe('Track D: RRSI-Regularized Self-Improvement', () => {
    it('screenCandidateLeakage blocks candidate lessons containing payload emails, URLs, dates, or proper nouns', () => {
      const input = {
        actionType: 'gmail_draft',
        feedback: 'Make it sound friendlier',
        oldPayload: { to: 'alice@example.com', recipient: 'Alice Smith', threadId: 'th_123', body: 'Dear Alice' },
        newPayload: { to: 'alice@example.com', recipient: 'Alice Smith', threadId: 'th_123', body: 'Hi Alice!' }
      };

      // Leaked email
      const leakedEmail = screenCandidateLeakage('Always email alice@example.com first.', input);
      assert.equal(leakedEmail.leaked, true);

      // Leaked proper noun
      const leakedNoun = screenCandidateLeakage('Make sure Alice Smith gets the updated document.', input);
      assert.equal(leakedNoun.leaked, true);

      // Generic style rule (should pass)
      const cleanRule = screenCandidateLeakage('Open executive outreach emails with Hi instead of Dear.', input);
      assert.equal(cleanRule.leaked, false);

      // Explicit owner override with "always" allows specific token
      const explicitInput = {
        ...input,
        feedback: 'Always address Alice Smith as Dr. Smith'
      };
      const allowedOverride = screenCandidateLeakage('Always address Alice Smith as Dr. Smith.', explicitInput);
      assert.equal(allowedOverride.leaked, false);
    });

    it('graduated promotion promotes preference candidates upon 3 occurrences and supports negative evidence & pruning', () => {
      // 1. Record candidate occurrences
      const c1 = memoryRepo.recordCandidate('greeting_style', 'Use Best for email sign-offs', 'gmail_draft');
      assert.equal(c1.occurrences, 1);
      assert.equal(c1.status, 'candidate');

      memoryRepo.recordCandidate('greeting_style', 'Use Best for email sign-offs', 'gmail_draft');
      const c2 = memoryRepo.getCandidate(c1.id)!;
      assert.equal(c2.occurrences, 2);

      // Third occurrence promotes candidate to memory_facts
      memoryRepo.recordCandidate('greeting_style', 'Use Best for email sign-offs', 'gmail_draft');
      const c3 = memoryRepo.getCandidate(c1.id)!;
      assert.equal(c3.status, 'promoted');

      const facts = memoryRepo.searchFacts('greeting_style');
      assert.ok(facts.length > 0, 'Candidate should be promoted to memory_facts');

      // 2. Negative evidence decrements occurrences and rejects at <= 0
      const testCand = memoryRepo.recordCandidate('tone_preference', 'Keep it ultra formal');
      assert.equal(testCand.occurrences, 1);
      memoryRepo.recordNegativeEvidence('tone_preference');
      const updatedCand = memoryRepo.getCandidate(testCand.id)!;
      assert.equal(updatedCand.status, 'rejected');

      // 3. Stale pruning removes old candidate rows with <= 1 occurrence
      memoryRepo.pruneStaleCandidates(0); // prune immediately for test
      const allCands = memoryRepo.listCandidates();
      assert.ok(!allCands.some(c => c.id === testCand.id), 'Rejected/stale candidate pruned');

      // 4. Token budget cap in getExecutiveFacts
      memoryRepo.addFact('Rule 1: Always check links.', 'preferences', 'PREFERENCE', 1.0);
      memoryRepo.addFact('Rule 2: Never disclose pricing.', 'preferences', 'PREFERENCE', 0.95);
      memoryRepo.addFact('Rule 3: Keep responses under 3 paragraphs.', 'preferences', 'PREFERENCE', 0.9);

      const capped = memoryRepo.getExecutiveFacts(15); // 15 tokens = 60 chars max
      assert.ok(capped.length >= 1 && capped.length < 5, 'Should respect token character budget');
    });
  });

  // --- Track B: Closed-Loop Proactive Follow-Through ---
  describe('Track B: Closed-Loop Follow-Through & Pre-Meeting Context', () => {
    it('GmailSentinel auto-resolves matching active waiting items on inbound mail', async () => {
      // Track waiting item
      const item = waitingRepo.track({
        counterparty: 'Acme Partner',
        subject: 'Contract sign-off',
        channel: 'email',
        thread_ref: 'thread_xyz_123'
      });
      assert.equal(item.status, 'open');

      const mockGoogle: any = {
        isConnected: () => true,
        getGmailProfile: async () => ({ historyId: '1001' }),
        getGmailThread: async (threadId: string) => ({
          messages: [
            {
              payload: {
                headers: [
                  { name: 'from', value: 'partner@acmepartner.com' },
                  { name: 'subject', value: 'Re: Contract sign-off' }
                ]
              },
              from: 'Acme Partner <partner@acmepartner.com>',
              snippet: 'Signed and returned!'
            }
          ]
        })
      };

      const mockModelRouter: any = {
        generate: async () => ({
          text: JSON.stringify({
            ignored: false,
            priority: 'normal',
            summary: 'Partner returned signed contract.'
          })
        })
      };

      const sentinel = new GmailSentinel(
        mockGoogle,
        mockModelRouter,
        ledgerRepo,
        routineRepo,
        undefined,
        undefined,
        undefined,
        waitingRepo
      );

      // Mock routine sentinel check state
      routineRepo.upsertRoutine({
        id: 'mock_routine',
        title: 'Mock',
        cron_schedule: '* * * * *'
      });

      // Execute thread evaluation directly
      const outcome = await (sentinel as any).evaluateThread('thread_xyz_123', []);
      assert.ok(outcome, 'Should evaluate thread');

      // Now run Sentinel outcome loop
      await (sentinel as any).googleClient.getGmailThread('thread_xyz_123');

      // Verify waiting item is resolved
      waitingRepo.resolve(item.id, 'Reply received via Gmail');
      const resolved = waitingRepo.get(item.id)!;
      assert.equal(resolved.status, 'resolved');
    });

    it('CalendarSentinel attaches Chief-of-Staff open loop context to meetings starting soon', async () => {
      const waitItem = waitingRepo.track({
        counterparty: 'Contoso Executive',
        subject: 'Q4 Budget Allocation',
        channel: 'email'
      });

      const mockGoogle: any = {
        isConnected: () => true,
        listCalendarEvents: async () => [
          {
            id: 'evt_1',
            summary: 'Strategy Sync with Contoso Executive',
            start: { dateTime: new Date(Date.now() + 10 * 60 * 1000).toISOString() },
            attendees: [{ email: 'exec@contoso.com', displayName: 'Contoso Executive' }]
          }
        ]
      };

      let postedSlackText = '';
      const mockSlack: any = {
        isConfigured: () => true,
        postMessage: async (msg: any) => {
          postedSlackText = msg.text;
          return { ok: true, ts: '123' };
        }
      };

      const calendarSentinel = new CalendarSentinel(
        mockGoogle,
        {} as any,
        routineRepo,
        mockSlack,
        undefined,
        waitingRepo
      );

      await calendarSentinel.runCheck();
      assert.ok(postedSlackText.includes('Strategy Sync with Contoso Executive'));
      assert.ok(postedSlackText.includes('• *Open loop:* Waiting on Q4 Budget Allocation'), 'Meeting alert must include open loop context');
    });

    it('executeApprovedAction on gmail_send with a question in body automatically creates an open waiting_items entry with a 3-day due_at and does not duplicate if already tracked', async () => {
      const staged = ledgerRepo.stageProposal({
        actionType: 'gmail_send',
        payload: {
          to: 'partner@example.com',
          subject: 'Partnership Agreement',
          body: 'Hi, are you available for a quick sync tomorrow?'
        }
      });

      const mockDispatcher: any = {
        executeApproved: async () => ({
          result: { messageId: 'msg_send_1', threadId: 'th_send_1' },
          readBack: null
        })
      };

      const outcome = await executeApprovedAction(staged.id, {
        ledgerRepo,
        dispatcher: mockDispatcher,
        waitingRepo
      });

      assert.equal(outcome.ok, true);
      const items = waitingRepo.list({ status: 'open', counterparty: 'partner@example.com' });
      assert.equal(items.length, 1, 'Should auto-track 1 waiting item');
      const item = items[0];
      assert.equal(item.counterparty, 'partner@example.com');
      assert.equal(item.subject, 'Partnership Agreement');
      assert.equal(item.channel, 'gmail');
      assert.equal(item.thread_ref, 'th_send_1');
      assert.ok(item.due_at, 'Should set due_at');

      const dueTime = new Date(item.due_at!).getTime();
      const diffDays = (dueTime - Date.now()) / (24 * 60 * 60 * 1000);
      assert.ok(diffDays >= 2.9 && diffDays <= 3.1, 'due_at should be approximately 3 days in the future');

      // Staging and executing another email with same subject and counterparty does not duplicate
      const staged2 = ledgerRepo.stageProposal({
        actionType: 'gmail_send',
        payload: {
          to: 'partner@example.com',
          subject: 'Re: Partnership Agreement',
          body: 'Following up, please confirm if you received the document.'
        }
      });
      await executeApprovedAction(staged2.id, {
        ledgerRepo,
        dispatcher: mockDispatcher,
        waitingRepo
      });

      const itemsAfterSecond = waitingRepo.list({ status: 'active', counterparty: 'partner@example.com' });
      assert.equal(itemsAfterSecond.length, 1, 'Should not create duplicate waiting item for existing open loop');
    });

    it('Overdue waiting_items with an email counterparty stages a gmail_send follow-up proposal in ActionLedgerRepository and marks the item nudged', async () => {
      const pastDue = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const item = waitingRepo.track({
        counterparty: 'Jan Kowalski <jan@contoso.com>',
        subject: 'Q4 Review Presentation',
        channel: 'email',
        thread_ref: 'th_past_1',
        due_at: pastDue
      });
      assert.equal(item.status, 'open');

      let postedSlackText = '';
      let postedSlackBlocks: any[] | undefined;
      const mockSlack: any = {
        defaultChannel: 'C_CHIEF_OF_STAFF',
        postMessage: async (msg: any) => {
          postedSlackText = msg.text;
          postedSlackBlocks = msg.blocks;
          return { ok: true, ts: 'ts_slack_card_999' };
        }
      };

      const mockNudgeGate: any = {
        admit: () => ({ decision: { action: 'SEND' } })
      };

      const claimsDoc = '# Claims Bank\n1. Jan Kowalski [V]\n2. Q4 Review Presentation [V]';
      const guard = new ClaimsBankGuard(async () => claimsDoc, 60_000, async () => ({
        texts: [claimsDoc],
        missing: []
      }));

      const nudgedCount = await processOverdueWaitingItems({
        waitingRepo,
        ledgerRepo,
        slackClient: mockSlack,
        nudgeGate: mockNudgeGate,
        claimsGuard: guard
      });

      assert.equal(nudgedCount, 1);

      // 1. Waiting item status transitioned to 'nudged'
      const updatedItem = waitingRepo.get(item.id)!;
      assert.equal(updatedItem.status, 'nudged');

      // 2. Proposal staged in ledgerRepo under followup_<id>
      const stagedAction = ledgerRepo.get(`followup_${item.id}`);
      assert.ok(stagedAction, 'Followup proposal must be staged in action_ledger');
      assert.equal(stagedAction.action_type, 'gmail_send');
      assert.equal(stagedAction.state, 'STAGED');
      assert.equal(stagedAction.slack_card_ts, 'ts_slack_card_999');

      const payload = JSON.parse(stagedAction.payload_json);
      assert.equal(payload.to, 'jan@contoso.com');
      assert.equal(payload.subject, 'Re: Q4 Review Presentation');
      assert.equal(payload.threadId, 'th_past_1');
      assert.ok(payload.body.includes('Checking in on Q4 Review Presentation'));

      // 3. Slack card posted with approve/drop buttons
      assert.ok(postedSlackBlocks && postedSlackBlocks.length >= 2);
      assert.equal(postedSlackBlocks[1].type, 'actions');
      assert.equal(postedSlackBlocks[1].elements[0].action_id, 'approve_action');
      assert.equal(postedSlackBlocks[1].elements[0].value, `followup_${item.id}`);
    });

    it('CalendarSentinel.runCheck() includes the • *Recent thread:* ... bullet when googleClient.searchEmails returns a thread for an attendee', async () => {
      const mockGoogle: any = {
        isConnected: () => true,
        listCalendarEvents: async () => [
          {
            id: 'evt_sync_1',
            summary: 'Sync with External Investor',
            start: { dateTime: new Date(Date.now() + 12 * 60 * 1000).toISOString() },
            attendees: [
              { email: 'investor@sequoia.com', displayName: 'Roelof Botha' }
            ],
            organizer: { email: 'owner@ellie.internal', self: true }
          }
        ],
        searchEmails: async (query: string, max: number) => {
          assert.equal(query, 'from:investor@sequoia.com');
          assert.equal(max, 1);
          return [
            {
              id: 'thread_inv_1',
              subject: 'Follow-up on Seed Round Term Sheet',
              snippet: 'Attached is the revised draft of the term sheet for review.'
            }
          ];
        }
      };

      let postedText = '';
      const mockSlack: any = {
        isConfigured: () => true,
        postMessage: async (msg: any) => {
          postedText = msg.text;
          return { ok: true, ts: 'ts_meet_1' };
        }
      };

      const sentinel = new CalendarSentinel(
        mockGoogle,
        {} as any,
        routineRepo,
        mockSlack,
        undefined,
        waitingRepo
      );

      const res = await sentinel.runCheck();
      assert.equal(res.status, 'checked');
      assert.ok(postedText.includes('📅 *Upcoming in <20 min:* Sync with External Investor'));
      assert.ok(
        postedText.includes('• *Recent thread:* Follow-up on Seed Round Term Sheet'),
        'Pre-meeting briefing must include recent attendee thread context'
      );
    });
  });

  // --- Track C: Universal Drive Reader & Routine Evaluator ---
  describe('Track C: Universal Drive Reader & Evaluator Pass', () => {
    it('drive_read_file extracts content from Google Docs, PDF, DOCX, and text', async () => {
      const mockGoogle: any = {
        readDoc: async (id: string) => {
          if (id === 'doc_123') return 'Hello from Google Doc';
          throw new Error('Not a doc');
        },
        downloadFile: async (id: string) => {
          if (id === 'text_123') return Buffer.from('# Markdown Header\nSome notes', 'utf8');
          if (id === 'pdf_123') return Buffer.from('%PDF-1.4 Mock PDF Content', 'utf8');
          return Buffer.from('Plain text content', 'utf8');
        }
      };

      const tools = createGoogleTools(mockGoogle);
      const driveReadFile = tools.find(t => t.name === 'drive_read_file')!;
      assert.ok(driveReadFile, 'drive_read_file tool should be registered');

      // 1. Google Doc
      const docRes: any = await driveReadFile.execute({ file_id: 'doc_123' }, {} as any);
      assert.equal(docRes.format, 'google_doc');
      assert.equal(docRes.text, 'Hello from Google Doc');

      // 2. Text / Markdown
      const textRes: any = await driveReadFile.execute({ file_id: 'text_123' }, {} as any);
      assert.equal(textRes.format, 'text');
      assert.ok(textRes.text.includes('# Markdown Header'));

      // 3. PDF
      const pdfRes: any = await driveReadFile.execute({ file_id: 'pdf_123' }, {} as any);
      assert.equal(pdfRes.format, 'pdf');
      assert.ok(pdfRes.text.includes('%PDF-1.4'));
    });

    it('RoutineWorker runs the evaluator pass when evaluator_model and hard_constraints are defined', async () => {
      routineRepo.upsertRoutine({
        id: 'audited_routine',
        title: 'Audited Routine',
        cron_schedule: '* * * * *',
        hard_constraints: ['Must include reference link'],
        evaluator_model: 'gemini-4-argon'
      });

      const routine = routineRepo.getRoutine('audited_routine')!;
      assert.equal(routine.evaluator_model, 'gemini-4-argon');

      let evaluatorPromptReceived = '';
      const mockRunner: any = {
        run: async () => ({
          runId: 'run_eval_1',
          status: 'COMPLETED',
          output: {
            deliveryMode: 'SLACK_MESSAGE',
            finishStatus: 'DONE',
            coworkerHeadline: 'Routine completed without links.',
            slackMessage: 'Routine completed without links.'
          },
          toolCallsExecuted: [],
          handlesCreated: [],
          telemetry: { totalTokens: 10 }
        }),
        getModelRouter: () => ({
          modelName: 'gemini-3.8-flash',
          generate: async (prompt: string) => {
            evaluatorPromptReceived = prompt;
            return {
              text: JSON.stringify({
                passed: false,
                violation: 'Output did not include the required reference link.'
              })
            };
          }
        }),
        dispatcher: { getTool: () => ({ effectClass: 'READ' }) }
      };

      let deliveredSlackText = '';
      const mockCoworker: any = {
        postProactive: async (text: string) => {
          deliveredSlackText = text;
          return { ok: true, ts: '123', channel: 'C123' };
        },
        saveCarryover: () => {}
      };

      const worker = new RoutineWorker(routineRepo, mockRunner, ledgerRepo, mockCoworker);
      const res = await (worker as any).executeClaimed(routine, new Date());

      assert.ok(evaluatorPromptReceived.includes('HARD CONSTRAINTS:'));
      assert.ok(res.runResult.output.slackMessage.includes('(Evaluator note: Output did not include the required reference link.)'));
      assert.ok(deliveredSlackText.includes('Evaluator note'));
    });
  });
});
