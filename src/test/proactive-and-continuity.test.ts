import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { ResultStore } from '../storage/result-store.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { groundReply } from '../governance/reply-grounding.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import {
  DEFAULT_ROUTINE_GRANT,
  resolveRoutineGrant,
  RoutineWorker
} from '../scheduler/routine-worker.js';
import { latestScheduledSlotAtOrBefore } from '../scheduler/cron.js';
import { NudgeGate } from '../scheduler/nudge-gate.js';
import { ReminderDispatcher } from '../scheduler/reminders.js';
import { GmailSentinel } from '../scheduler/sentinels/gmail-sentinel.js';
import { CalendarSentinel } from '../scheduler/sentinels/calendar-sentinel.js';
import { ProtonSentinel } from '../scheduler/sentinels/proton-sentinel.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { buildRuntime } from '../runtime/build-runtime.js';

const telemetry = {
  model: 'gemini-3.8-flash',
  promptTokens: 10,
  cachedTokens: 0,
  thinkingTokens: 0,
  candidatesTokens: 5,
  totalTokens: 15,
  durationMs: 5
};

describe('Phase 1: Proactive Execution & Attention Wiring', { concurrency: 1 }, () => {
  describe('1.1 Default Routine Tool Grant & Tool Aliases', () => {
    it('includes owner_sources_read, owner_text_check, document_render, and job_evaluate in DEFAULT_ROUTINE_GRANT', () => {
      for (const expected of [
        'owner_sources_read',
        'owner_text_check',
        'document_render',
        'visual_document_render',
        'job_evaluate',
        'drive_search',
        'calendar_list'
      ]) {
        assert.ok(DEFAULT_ROUTINE_GRANT.includes(expected), `Expected DEFAULT_ROUTINE_GRANT to include ${expected}`);
      }
    });

    it('registers all DEFAULT_ROUTINE_GRANT tools in buildRuntime and resolves without unavailable warnings when default_grant is unset', () => {
      const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
      for (const name of DEFAULT_ROUTINE_GRANT) {
        assert.ok(runtime.dispatcher.getTool(name), `Expected '${name}' to be registered in dispatcher`);
      }

      runtime.routineRepo.upsertRoutine({
        id: 'test_default_grant_routine',
        title: 'Default Grant Routine',
        cron_schedule: '0 9 * * *'
      });
      const routine = runtime.routineRepo.getRoutine('test_default_grant_routine')!;
      const resolved = resolveRoutineGrant(routine, name => Boolean(runtime.dispatcher.getTool(name)));
      assert.deepEqual(resolved.unavailable, []);
      assert.ok(resolved.tools.has('owner_sources_read'));
      assert.ok(resolved.tools.has('owner_text_check'));
      assert.ok(resolved.tools.has('document_render'));
    });
  });

  describe('1.2 Sub-Daily / Multi-Slot Cron Deduplication', () => {
    it('latestScheduledSlotAtOrBefore finds the most recent slot within lookback window', () => {
      // 14:05 Warsaw time on a Monday, for cron "0 9,14 * * *"
      const now = new Date('2026-10-12T12:05:00.000Z'); // 14:05 CEST (UTC+2)
      const slot = latestScheduledSlotAtOrBefore('0 9,14 * * *', now, 'Europe/Warsaw');
      assert.ok(slot);
      assert.equal(slot!.toISOString(), '2026-10-12T12:00:00.000Z');
    });

    it('runs a sub-daily routine at both 09:00 and 14:00 on the same calendar day', async () => {
      const appDb = new DatabaseSync(':memory:');
      const ledgerDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      initializeLedgerDatabase(ledgerDb);
      const routineRepo = new RoutineRepository(appDb);
      const ledgerRepo = new ActionLedgerRepository(ledgerDb);
      const dispatcher = new ToolDispatcher(ledgerRepo);

      let executions = 0;
      const mockRouter: any = {
        modelName: 'test',
        generate: async () => {
          executions++;
          return {
            text: '',
            functionCalls: [{ name: 'finish', args: { status: 'DONE', message: `Sub-daily run #${executions}` } }],
            telemetry,
            rawResponse: {}
          };
        }
      };
      const runner = new UnifiedAgentRunner(mockRouter, dispatcher);
      const worker = new RoutineWorker(routineRepo, runner, ledgerRepo);

      routineRepo.upsertRoutine({
        id: 'twice_daily',
        title: 'Twice Daily Check',
        cron_schedule: '0 9,14 * * *',
        timezone: 'Europe/Warsaw'
      });
      // Seed last_run_at to yesterday so first-boot stampede guard is satisfied
      routineRepo.updateLastRun('twice_daily', '2026-10-11T12:00:00.000Z');

      // 1. Morning slot at 09:05 CEST (07:05 UTC)
      const morning = new Date('2026-10-12T07:05:00.000Z');
      const res1 = await worker.runDueRoutines(morning, 1);
      assert.equal(res1.routinesRun, 1);
      assert.equal(executions, 1);

      // 2. Duplicate check at 09:10 CEST -> should NOT re-run for the 09:00 slot
      const morningDup = new Date('2026-10-12T07:10:00.000Z');
      const resDup = await worker.runDueRoutines(morningDup, 1);
      assert.equal(resDup.routinesRun, 0);
      assert.equal(executions, 1);

      // 3. Afternoon slot at 14:05 CEST (12:05 UTC) on the SAME day -> MUST run!
      const afternoon = new Date('2026-10-12T12:05:00.000Z');
      const res2 = await worker.runDueRoutines(afternoon, 1);
      assert.equal(res2.routinesRun, 1);
      assert.equal(executions, 2);
    });
  });

  describe('1.3 NudgeGate Wired Into Proactive Outreach (Reminders & Sentinels)', () => {
    it('holds due reminders during quiet hours / snooze and logs them in nudge_log', async () => {
      const appDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);

      // Clock fixed at 12:00 UTC (14:00 Warsaw, outside quiet hours), then snoozed
      const now = new Date('2026-10-12T12:00:00.000Z');
      const nudgeGate = new NudgeGate(appDb, undefined, () => now);
      nudgeGate.snooze(new Date('2026-10-12T16:00:00.000Z'));

      const posted: any[] = [];
      const slackClient: any = {
        isConfigured: () => true,
        defaultChannel: 'C_OWNER',
        postMessage: async (msg: any) => {
          posted.push(msg);
          return { ok: true, ts: '1.1' };
        }
      };

      const reminders = new ReminderDispatcher(appDb, slackClient, nudgeGate);
      reminders.addReminder('Follow up with vendor', new Date('2026-10-12T11:30:00.000Z'), 'C_OWNER');

      const countHeld = await reminders.dispatchDueReminders(now);
      assert.equal(countHeld, 0);
      assert.equal(posted.length, 0);

      // Held item is logged in nudge_log and can be delivered via deliverHeldMessagesNow
      const delivered = nudgeGate.deliverHeldMessagesNow();
      assert.equal(delivered.deliveredCount, 1);
      assert.match(delivered.messages[0], /Follow up with vendor/);
    });
  });

  describe('1.4 GmailSentinel End-to-End Wiring (Sender Rules, Surface, Draft + Card)', () => {
    let appDb: DatabaseSync;
    let ledgerDb: DatabaseSync;
    let routineRepo: RoutineRepository;
    let ledgerRepo: ActionLedgerRepository;
    let nudgeGate: NudgeGate;
    let posted: any[];
    let slackClient: any;

    beforeEach(() => {
      appDb = new DatabaseSync(':memory:');
      ledgerDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      initializeLedgerDatabase(ledgerDb);
      routineRepo = new RoutineRepository(appDb);
      ledgerRepo = new ActionLedgerRepository(ledgerDb);
      const daytime = new Date('2026-10-12T10:00:00.000Z');
      nudgeGate = new NudgeGate(appDb, undefined, () => daytime);
      posted = [];
      slackClient = {
        isConfigured: () => true,
        defaultChannel: 'C_INBOX',
        postMessage: async (msg: any) => {
          posted.push(msg);
          return { ok: true, ts: `card_${posted.length}` };
        }
      };
    });

    it('skips LLM triage for ignored sender rules, surfaces VIP messages, and stages + posts approval cards for draft_reply', async () => {
      routineRepo.addSenderRule('gmail_sentinel', 'ignore', '@spam-domain.test', 'Marketing');
      routineRepo.addSenderRule('gmail_sentinel', 'vip', 'board-member@partner.org', 'Board');

      const threads: Record<string, any> = {
        t_ignored: {
          messages: [{
            snippet: 'Buy now!',
            payload: { headers: [{ name: 'From', value: 'Promo <promo@spam-domain.test>' }, { name: 'Subject', value: 'Sale' }] }
          }]
        },
        t_vip: {
          messages: [{
            snippet: 'FYI board deck looks good.',
            payload: { headers: [{ name: 'From', value: 'Board <board-member@partner.org>' }, { name: 'Subject', value: 'Board update' }] }
          }]
        },
        t_draft: {
          messages: [{
            snippet: 'Can we meet Thursday at 15:00?',
            payload: { headers: [{ name: 'From', value: 'Client <client@acme.example>' }, { name: 'Subject', value: 'Thursday sync' }] }
          }]
        }
      };

      let llmCalls = 0;
      const mockRouter: any = {
        generate: async (prompt: string) => {
          llmCalls++;
          if (prompt.includes('board-member@partner.org')) {
            // Even if LLM says ignore, VIP rule forces surfacing
            return {
              text: JSON.stringify({
                requiresAction: false,
                category: 'INFORMATIONAL',
                recommendedAction: 'ignore',
                reason: 'FYI note from board member.'
              }),
              telemetry
            };
          }
          return {
            text: JSON.stringify({
              requiresAction: true,
              category: 'URGENT',
              recommendedAction: 'draft_reply',
              reason: 'Client requested meeting confirmation.',
              draftBody: 'Thursday at 15:00 works well.'
            }),
            telemetry
          };
        }
      };

      const googleClient: any = {
        isConnected: () => true,
        getGmailProfile: async () => ({ emailAddress: 'owner@example.org', historyId: 'h_200', messagesTotal: 10 }),
        listGmailThreads: async () => [{ id: 't_ignored' }, { id: 't_vip' }, { id: 't_draft' }],
        getGmailThread: async (id: string) => threads[id]
      };

      const sentinel = new GmailSentinel(googleClient, mockRouter, ledgerRepo, routineRepo, slackClient, nudgeGate);
      const report = await sentinel.runCheck();

      assert.equal(llmCalls, 2, 'Ignored sender must skip LLM triage');
      assert.equal(report.draftsStagedCount, 1);
      assert.equal(posted.length, 2, 'Should post 1 VIP surface message and 1 approval card');

      const staged = ledgerRepo.listStaged();
      assert.equal(staged.length, 1);
      assert.equal(staged[0].action_type, 'gmail_draft');
      assert.ok(staged[0].slack_card_ts, 'Approval card ts should be saved on staged ledger record');

      const cardPost = posted.find(p => Array.isArray(p.blocks));
      assert.ok(cardPost, 'Expected Slack approval card with blocks');
      const surfacePost = posted.find(p => !p.blocks);
      assert.ok(surfacePost);
      assert.match(surfacePost.text, /Board update/);
    });
  });

  describe('1.5 CalendarSentinel & ProtonSentinel Triage and Deduplication', () => {
    it('CalendarSentinel alerts once per <20 min event and deduplicates via seen_ids on subsequent checks', async () => {
      const appDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      const routineRepo = new RoutineRepository(appDb);
      const daytime = new Date('2026-10-12T10:00:00.000Z');
      const nudgeGate = new NudgeGate(appDb, undefined, () => daytime);

      const posted: any[] = [];
      const slackClient: any = {
        isConfigured: () => true,
        defaultChannel: 'C_CAL',
        postMessage: async (msg: any) => { posted.push(msg); return { ok: true, ts: '1.0' }; }
      };

      const in10Min = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const googleClient: any = {
        isConnected: () => true,
        listCalendarEvents: async () => [{ id: 'evt_soon_1', summary: 'Quarterly Review', start: { dateTime: in10Min } }]
      };

      const sentinel = new CalendarSentinel(googleClient, {} as any, routineRepo, slackClient, nudgeGate);
      const first = await sentinel.runCheck();
      assert.equal(first.briefedCount, 1);
      assert.equal(posted.length, 1);
      assert.match(posted[0].text, /Quarterly Review/);

      // Second wake cycle 5 minutes later: same event is still <20 min away, must NOT re-alert
      const second = await sentinel.runCheck();
      assert.equal(second.briefedCount, 0);
      assert.equal(posted.length, 1);

      const state = JSON.parse(routineRepo.getSentinel('calendar_sentinel').state_json || '{}');
      assert.ok(Array.isArray(state.seen_ids) && state.seen_ids.includes('evt_soon_1'));
    });

    it('ProtonSentinel tracks seen_ids, enforces sender rules, stages proton_draft, and posts Slack cards', async () => {
      const appDb = new DatabaseSync(':memory:');
      const ledgerDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      initializeLedgerDatabase(ledgerDb);
      const routineRepo = new RoutineRepository(appDb);
      const ledgerRepo = new ActionLedgerRepository(ledgerDb);
      const daytime = new Date('2026-10-12T10:00:00.000Z');
      const nudgeGate = new NudgeGate(appDb, undefined, () => daytime);

      routineRepo.addSenderRule('proton_sentinel', 'ignore', 'newsletter@noise.example');

      const posted: any[] = [];
      const slackClient: any = {
        isConfigured: () => true,
        defaultChannel: 'C_PROTON',
        postMessage: async (msg: any) => { posted.push(msg); return { ok: true, ts: `p_${posted.length}` }; }
      };

      const protonClient: any = {
        isEnabled: () => true,
        getMailboxStatus: async () => ({ uidNext: 42, unseen: 2, messages: 10 }),
        listUnread: async () => [
          {
            uid: 40,
            messageId: '<m40@noise.example>',
            fromEmail: 'newsletter@noise.example',
            fromName: 'Noise',
            subject: 'Weekly Digest',
            snippet: 'Unsubscribe'
          },
          {
            uid: 41,
            messageId: '<m41@partner.example>',
            fromEmail: 'counsel@partner.example',
            fromName: 'Legal Counsel',
            subject: 'Contract Addendum',
            snippet: 'Please confirm receipt of the addendum.'
          }
        ]
      };

      let llmCalls = 0;
      const mockRouter: any = {
        generate: async () => {
          llmCalls++;
          return {
            text: JSON.stringify({
              requiresAction: true,
              category: 'URGENT',
              recommendedAction: 'draft_reply',
              reason: 'Confirm receipt of contract addendum.',
              draftBody: 'Received, thank you — reviewing today.'
            }),
            telemetry
          };
        }
      };

      const sentinel = new ProtonSentinel(protonClient, mockRouter, ledgerRepo, routineRepo, slackClient, nudgeGate);
      const first = await sentinel.runCheck();
      assert.equal(llmCalls, 1, 'Ignored Proton sender must not trigger LLM call');
      assert.equal(first.draftsStagedCount, 1);
      assert.equal(posted.length, 1);
      assert.ok(Array.isArray(posted[0].blocks), 'Expected Slack quote card for proton_draft');

      // Second check with same UIDs: seen_ids prevents re-triaging
      const second = await sentinel.runCheck();
      assert.equal(second.draftsStagedCount, 0);
      assert.equal(llmCalls, 1);
    });
  });
});

describe('Phase 2: Thread Continuity & Governance Tightening', { concurrency: 1 }, () => {
  describe('2.1 Preserve Thread Images Across Follow-Up Turns', () => {
    it('downloads recent images from prior thread messages and includes them on follow-up turns', async () => {
      let capturedOpts: any = null;
      const mockSlackClient: any = {
        isConfigured: () => true,
        addReaction: async () => ({ ok: true }),
        removeReaction: async () => ({ ok: true }),
        postMessage: async () => ({ ok: true, ts: '200.9' }),
        getConversationReplies: async () => [
          {
            ts: '200.1',
            user: 'U_USER',
            text: 'Here is the architecture diagram',
            files: [
              {
                id: 'F_IMG_1',
                name: 'diagram.png',
                mimetype: 'image/png',
                url_private_download: 'https://files.slack.com/diagram.png'
              }
            ]
          },
          {
            ts: '200.2',
            bot_id: 'B_BOT',
            text: 'I see the three service tiers.'
          },
          {
            ts: '200.3',
            user: 'U_USER',
            text: 'What port is shown on the middle box?'
          }
        ],
        downloadFile: async () => ({
          buffer: Buffer.from('diagram-png-binary'),
          mimeType: 'image/png'
        })
      };

      const mockLedger: any = {
        getLatestStagedByThreadTs: () => null,
        listStagedByRun: () => []
      };

      const mockRunner: any = {
        dispatcher: { getAllTools: () => [], getTool: () => undefined },
        run: async (opts: any) => {
          capturedOpts = opts;
          return {
            runId: 'run_img_followup',
            status: 'COMPLETED',
            output: { deliveryMode: 'SLACK_MESSAGE', coworkerHeadline: 'Port 8080.', summary: 'Port 8080.' },
            toolCallsExecuted: [],
            handlesCreated: [],
            telemetry
          };
        }
      };

      const service = new SlackCoworkerService(mockSlackClient, mockLedger, mockRunner);
      await service.handleUserMessage({
        type: 'message',
        user: 'U_USER',
        text: 'What port is shown on the middle box?',
        ts: '200.3',
        thread_ts: '200.1',
        channel: 'D_CHAN'
      });

      assert.ok(capturedOpts);
      const expectedBase64 = Buffer.from('diagram-png-binary').toString('base64');
      const inHistory = capturedOpts.conversationHistory[0].parts.some(
        (p: any) => p.inlineData?.data === expectedBase64
      );
      const inUserParts = capturedOpts.userParts.some(
        (p: any) => p.inlineData?.data === expectedBase64
      );
      assert.ok(inHistory || inUserParts, 'Follow-up turn must include the thread image inlineData');
    });
  });

  describe('2.2 Exclude Non-Evidence / Self-Diagnosis Tools From Thread Carryover', () => {
    it('excludes trace_inspect_*, repo_*, owner_text_check, and memory_list_candidates from thread carryover', () => {
      const appDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      const store = new ResultStore(appDb);
      const carryover = new ThreadCarryoverRepository(appDb, store);

      const largeText = 'Fact payload '.repeat(80);
      carryover.save('C1:500', {
        runId: 'run_mixed',
        status: 'COMPLETED',
        output: { deliveryMode: 'SLACK_MESSAGE', finishStatus: 'DONE', summary: 'Checked traces and docs' },
        toolCallsExecuted: [
          { tool: 'trace_inspect_recent', params: { limit: 5 }, result: { traces: [largeText] }, durationMs: 1 },
          { tool: 'repo_read_file', params: { path: 'src/index.ts' }, result: { content: largeText }, durationMs: 1 },
          { tool: 'owner_text_check', params: { text: 'draft' }, result: { ok: true, content: largeText }, durationMs: 1 },
          { tool: 'memory_list_candidates', params: {}, result: { candidates: [largeText] }, durationMs: 1 },
          { tool: 'docs_read', params: { documentId: 'doc_123' }, result: { content: largeText }, durationMs: 1 }
        ],
        handlesCreated: [],
        telemetry,
        wallMs: 10
      });

      const summary = carryover.get('C1:500')!;
      assert.match(summary, /docs_read/);
      assert.doesNotMatch(summary, /trace_inspect_recent/);
      assert.doesNotMatch(summary, /repo_read_file/);
      assert.doesNotMatch(summary, /owner_text_check/);
      assert.doesNotMatch(summary, /memory_list_candidates/);
    });
  });

  describe('2.3 Enforce Claims Bank & Header Stripping on In-Thread Revisions', () => {
    it('strips repeated headers on valid revisions and rejects revisions that violate Claims Bank', async () => {
      const appDb = new DatabaseSync(':memory:');
      const ledgerDb = new DatabaseSync(':memory:');
      initializeAppDatabase(appDb);
      initializeLedgerDatabase(ledgerDb);
      const ledgerRepo = new ActionLedgerRepository(ledgerDb);

      const claimsDoc = [
        '# Claims Bank',
        '1. Built a support team of 12 people. [V]',
        '# [X] Never Claim',
        '- "Guaranteed 10x ROI"'
      ].join('\n');
      const claimsGuard = new ClaimsBankGuard(async () => claimsDoc);
      const dispatcher = new ToolDispatcher(ledgerRepo, new ResultStore(appDb), claimsGuard);
      dispatcher.registerTool({
        name: 'gmail_send',
        description: 'send email',
        effectClass: 'CONSEQUENTIAL',
        schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
        ownerText: { kind: 'message', field: 'body', text: (p: any) => `${p.subject}\n\n${p.body}` },
        execute: async () => ({ ok: true })
      });

      const staged = ledgerRepo.stageProposal({
        actionId: 'act_rev_1',
        actionType: 'gmail_send',
        payload: { to: 'alex@client.org', subject: 'Intro', body: 'Built a support team of 12 people.' },
        slackChannel: 'D1',
        slackThreadTs: '300.1'
      });
      ledgerRepo.updateSlackCardTs(staged.id, '300.2');

      const posted: any[] = [];
      const updatedCards: any[] = [];
      const slackClient: any = {
        isConfigured: () => true,
        addReaction: async () => ({ ok: true }),
        removeReaction: async () => ({ ok: true }),
        getConversationReplies: async () => [],
        downloadFile: async () => null,
        postMessage: async (m: any) => { posted.push(m); return { ok: true, ts: '300.9' }; },
        updateMessage: async (m: any) => { updatedCards.push(m); return { ok: true }; }
      };

      let nextModelJson: any = {};
      const mockRunner: any = {
        dispatcher,
        modelRouter: {
          generate: async () => ({
            text: JSON.stringify(nextModelJson),
            telemetry
          })
        }
      };

      const service = new SlackCoworkerService(slackClient, ledgerRepo, mockRunner);

      // 1. Revision with repeated Subject header + sourced claim -> strips header and updates payload
      nextModelJson = {
        to: 'alex@client.org',
        subject: 'Intro',
        body: 'Subject: Intro\nTo: alex@client.org\n\nBuilt a support team of 12 people.'
      };
      await service.handleUserMessage({
        type: 'message',
        user: 'U_OWNER',
        text: 'tighten the opening',
        ts: '300.3',
        thread_ts: '300.1',
        channel: 'D1'
      });

      const afterValid = JSON.parse(ledgerRepo.get(staged.id)!.payload_json);
      assert.equal(afterValid.body, 'Built a support team of 12 people.', 'Repeated headers must be stripped');
      assert.equal(updatedCards.length, 1);

      // 2. Revision introducing an unsourced metric (95 people) -> rejected by Claims Bank guard!
      nextModelJson = {
        to: 'alex@client.org',
        subject: 'Intro',
        body: 'Built a support team of 95 people with Guaranteed 10x ROI.'
      };
      await service.handleUserMessage({
        type: 'message',
        user: 'U_OWNER',
        text: 'say 95 people and guaranteed 10x ROI',
        ts: '300.4',
        thread_ts: '300.1',
        channel: 'D1'
      });

      const afterInvalid = JSON.parse(ledgerRepo.get(staged.id)!.payload_json);
      assert.equal(afterInvalid.body, 'Built a support team of 12 people.', 'Staged payload must not be overwritten with unverified claims');
      assert.equal(updatedCards.length, 1, 'Card must not be updated on rejected revision');
      assert.equal(posted.length, 1, 'Violation explanation must be posted in the Slack thread');
      assert.match(posted[0].text, /UNSOURCED_CLAIM|NEVER_CLAIM/);
    });
  });

  describe('2.4 Surface FAILED Ledger Actions in Reply Receipts', () => {
    it('discloses FAILED / FAILED_SAFE / RECONCILIATION_REQUIRED ledger actions and failed write tool calls when omitted by the model', () => {
      const reply = groundReply(
        'All set — I have processed your updates.',
        [
          {
            tool: 'sheets_append',
            params: {},
            result: { ok: false, error: 'Spreadsheet permission denied' },
            durationMs: 10
          }
        ],
        [
          {
            id: 'act_fail_1',
            action_type: 'gmail_send',
            state: 'FAILED_SAFE',
            last_error: 'SMTP timeout'
          }
        ]
      )!;

      assert.match(reply, /failed action in this run/i);
      assert.match(reply, /gmail_send.*FAILED_SAFE.*SMTP timeout/);
      assert.match(reply, /sheets_append.*FAILED.*Spreadsheet permission denied/);
    });
  });
});
