import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { MemoryRepository } from '../storage/memory-repo.js';
import { extractCorrectionLesson } from '../agent/correction-extractor.js';
import { createQueueRouter } from '../http/routes/queue.js';
import { SlackCoworkerService, SlackEventPayload } from '../integrations/slack/coworker.js';
import { SlackClient } from '../integrations/slack/client.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { ResultStore } from '../storage/result-store.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { AuthoredResources } from '../storage/authored-resources.js';
import { OwnerConfigLoader, parseOwnerConfig, ownerIntro, setOwnerConfig, EMPTY_OWNER_CONFIG } from '../config/owner.js';
import { buildRuntime } from '../runtime/build-runtime.js';
import type { ModelRouter, ModelCallConfig, ModelCallResponse } from '../models/model-router.js';

describe('Phase 4: Self-Improvement Loop & Owner Config Wiring', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let memoryRepo: MemoryRepository;
  let ledgerRepo: ActionLedgerRepository;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    memoryRepo = new MemoryRepository(appDb);
    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const resultStore = new ResultStore(appDb);
    const claimsDoc = [
      '# Claims Bank',
      '1. Built a support team of 12 people. [V]',
      '# [X] Never Claim',
      '- "Guaranteed 10x ROI"'
    ].join('\n');
    const claimsGuard = new ClaimsBankGuard(async () => claimsDoc);
    dispatcher = new ToolDispatcher(ledgerRepo, resultStore, claimsGuard, new AuthoredResources(appDb));
    setOwnerConfig(EMPTY_OWNER_CONFIG);
  });

  afterEach(() => {
    try { appDb.close(); } catch {}
    try { ledgerDb.close(); } catch {}
    setOwnerConfig(EMPTY_OWNER_CONFIG);
  });

  describe('4.1 Preference Extraction on Corrections', () => {
    it('extractCorrectionLesson extracts concise 1-sentence lesson from modelRouter', async () => {
      const mockModelRouter = {
        generate: async (prompt: string): Promise<ModelCallResponse> => {
          assert.ok(prompt.includes('gmail_send'));
          return {
            text: 'Do not open outreach emails with pleasantries like "hope you are well".',
            telemetry: {} as any
          };
        }
      } as unknown as ModelRouter;

      const lesson = await extractCorrectionLesson(mockModelRouter, {
        actionType: 'gmail_send',
        feedback: 'Too friendly and robotic. Cut the pleasantries.',
        oldPayload: { to: 'recruiter@example.com', body: 'Hope this finds you well. I saw your job posting.' },
        newPayload: { to: 'recruiter@example.com', body: 'I saw your job posting and am interested in the role.' }
      });

      assert.equal(lesson, 'Do not open outreach emails with pleasantries like "hope you are well".');
    });

    it('extractCorrectionLesson returns null when model indicates situational change (NONE)', async () => {
      const mockModelRouter = {
        generate: async (): Promise<ModelCallResponse> => ({
          text: 'NONE',
          telemetry: {} as any
        })
      } as unknown as ModelRouter;

      const lesson = await extractCorrectionLesson(mockModelRouter, {
        actionType: 'gmail_send',
        oldPayload: { to: 'wrong@example.com' },
        newPayload: { to: 'right@example.com' }
      });

      assert.equal(lesson, null);
    });

    it('PUT /api/queue/:id extracts style lesson and records fact (source: correction, confidence: 0.9)', async () => {
      // Stage an action in ledger
      const staged = ledgerRepo.stageProposal({
        actionType: 'gmail_send',
        payload: {
          to: 'client@example.com',
          subject: 'Proposal',
          body: 'Dear Sir, I am writing to propose a comprehensive consultation framework.'
        },
        batchId: 'batch-1'
      });

      const mockModelRouter = {
        generate: async (): Promise<ModelCallResponse> => ({
          text: 'Avoid overly stiff corporate openings like "Dear Sir, I am writing to propose".',
          telemetry: {} as any
        })
      } as unknown as ModelRouter;

      const router = createQueueRouter(ledgerRepo, dispatcher, memoryRepo, mockModelRouter);

      // Find PUT /:id route handler
      const putRoute = (router as any).stack.find((s: any) => s.route?.path === '/:id' && s.route?.methods?.put);
      assert.ok(putRoute, 'PUT /:id route should exist');
      const handler = putRoute.route.stack[0].handle;

      const fakeReq: any = {
        params: { id: staged.id },
        body: {
          to: 'client@example.com',
          subject: 'Proposal',
          body: 'Here is our outline for the consultation project.'
        }
      };

      let jsonResponse: any = null;
      let statusCode = 200;
      const fakeRes: any = {
        status: (code: number) => { statusCode = code; return fakeRes; },
        json: (data: any) => { jsonResponse = data; return fakeRes; }
      };

      await handler(fakeReq, fakeRes);

      assert.equal(statusCode, 200);
      assert.equal(jsonResponse?.ok, true);

      // Verify payload was updated in ledger
      const updated = ledgerRepo.get(staged.id);
      assert.ok(updated);
      assert.ok(updated.payload_json.includes('Here is our outline'));

      // Verify preference rule was added to MemoryRepository with source='correction' and confidence=0.9
      const facts = memoryRepo.listAllFacts();
      const correctionFact = facts.find(f => f.source === 'correction');
      assert.ok(correctionFact, 'Expected a fact with source: correction');
      assert.equal(correctionFact.confidence, 0.9);
      assert.equal(correctionFact.category, 'PREFERENCE');
      assert.equal(correctionFact.domain, 'preferences');
      assert.equal(correctionFact.statement, 'Avoid overly stiff corporate openings like "Dear Sir, I am writing to propose".');

      // Executive facts (confidence >= 0.8) should contain this lesson!
      const execFacts = memoryRepo.getExecutiveFacts();
      assert.ok(execFacts.some(f => f.statement === correctionFact.statement));
    });

    it('Slack in-thread revision extracts preference lesson and stores in memoryRepo', async () => {
      // Stage an action with a slack_card_ts
      const staged = ledgerRepo.stageProposal({
        actionType: 'gmail_send',
        payload: {
          to: 'lead@startup.io',
          subject: 'Quick question',
          body: 'Hope you are doing well! I wanted to follow up and see if you are available to chat.'
        },
        slackThreadTs: '1791933382.1111'
      });
      ledgerRepo.updateSlackCardTs(staged.id, '1791933382.1111');

      const updatedPayload = {
        to: 'lead@startup.io',
        subject: 'Quick question',
        body: 'Following up on our discussion — let me know if you are available to chat.'
      };

      const mockModelRouter = {
        generate: async (prompt: string, config?: any): Promise<ModelCallResponse> => {
          if (config?.responseMimeType === 'application/json') {
            return {
              text: JSON.stringify(updatedPayload),
              telemetry: {} as any
            };
          }
          // Lesson extraction call
          return {
            text: 'Cut pleasantries and follow up directly.',
            telemetry: {} as any
          };
        }
      } as unknown as ModelRouter;

      let postedMsg: any = null;
      const mockSlackClient = {
        isConfigured: () => true,
        postMessage: async (msg: any) => {
          postedMsg = msg;
          return { ok: true, ts: '1791933382.3333' };
        },
        updateMessage: async () => ({ ok: true }),
        removeReaction: async () => ({ ok: true }),
        addReaction: async () => ({ ok: true }),
        getConversationReplies: async () => []
      } as unknown as SlackClient;

      const mockRunner = {
        modelRouter: mockModelRouter,
        dispatcher,
        memoryRepo
      } as unknown as UnifiedAgentRunner;

      const coworkerService = new SlackCoworkerService(
        mockSlackClient,
        ledgerRepo,
        mockRunner,
        undefined,
        undefined,
        undefined,
        undefined,
        memoryRepo
      );

      const event: SlackEventPayload = {
        type: 'message',
        user: 'U0OWNERTEST',
        text: 'Too bubbly. Cut pleasantries and follow up directly.',
        ts: '1791933382.2222',
        thread_ts: staged.slack_thread_ts || '1791933382.1111',
        channel: 'C0TESTCHANNEL'
      };

      await coworkerService.handleUserMessage(event);

      // Verify staged action payload updated
      const inLedger = ledgerRepo.get(staged.id);
      assert.ok(inLedger);
      assert.ok(inLedger.payload_json.includes('Following up on our discussion'));

      // Verify lesson recorded in memoryRepo
      const facts = memoryRepo.listAllFacts();
      const correctionFact = facts.find(f => f.source === 'correction');
      assert.ok(correctionFact, 'Expected in-thread revision to record a correction fact');
      assert.equal(correctionFact.confidence, 0.9);
      assert.equal(correctionFact.statement, 'Cut pleasantries and follow up directly.');
    });
  });

  describe('4.2 Wire OwnerConfigLoader', () => {
    it('parseOwnerConfig extracts rules and preferences from config doc text', () => {
      const docText = `
# About
Experienced engineering leader.

# Target Roles
- VP of Engineering
- Head of Autonomous Systems

# Deal-Breakers
- No relocation outside Europe

# Pay
Minimum $220k base + equity

# Never Resurface
- Crypto gambling projects
- Unfunded seed startups

# Preferences
- Always keep executive memos under 2 pages
- Never schedule morning meetings before 10:00

# Meeting Windows
10:00 - 16:00
`;

      const cfg = parseOwnerConfig(docText, '15+ years experience building distributed systems.');

      assert.equal(cfg.about, 'Experienced engineering leader.');
      assert.deepEqual(cfg.targetRoles, ['VP of Engineering', 'Head of Autonomous Systems']);
      assert.deepEqual(cfg.dealBreakers, ['No relocation outside Europe']);
      assert.equal(cfg.pay, 'Minimum $220k base + equity');
      assert.deepEqual(cfg.neverResurface, ['Crypto gambling projects', 'Unfunded seed startups']);
      assert.ok(cfg.rules.includes('Always keep executive memos under 2 pages'));
      assert.ok(cfg.rules.includes('Never schedule morning meetings before 10:00'));
      assert.equal(cfg.professionalRecord, '15+ years experience building distributed systems.');
    });

    it('ownerIntro includes rules, pay, and neverResurface when configured', () => {
      setOwnerConfig({
        about: 'Engineering director.',
        targetRoles: ['VP of Engineering'],
        dealBreakers: ['No relocation'],
        pay: '$250k+',
        neverResurface: ['Spam companies'],
        rules: ['Be concise in Slack.', 'Do not use buzzwords.']
      });

      const intro = ownerIntro();
      assert.ok(intro.includes('Target Roles: VP of Engineering'));
      assert.ok(intro.includes('Pay / Compensation: $250k+'));
      assert.ok(intro.includes('Never Resurface: Spam companies'));
      assert.ok(intro.includes('Owner Rules & Preferences:'));
      assert.ok(intro.includes('• Be concise in Slack.'));
      assert.ok(intro.includes('• Do not use buzzwords.'));
    });

    it('OwnerConfigLoader caches in SQLite and applies config', async () => {
      const configDoc = `
# About
Fractional CTO and AI Architect.

# Target Roles
- Chief AI Officer
- Head of Product Engineering

# Rules
- Use TypeScript strictly
- Ground all metrics before asserting
`;

      const profRecord = 'Delivered multi-agent orchestration systems.';

      let readDocCount = 0;
      const loader = new OwnerConfigLoader(
        appDb,
        async (id: string) => {
          readDocCount++;
          if (id === 'doc-config-1') return configDoc;
          if (id === 'doc-prof-1') return profRecord;
          return '';
        },
        'doc-config-1',
        'doc-prof-1'
      );

      // Force refresh
      await loader.refresh();
      assert.equal(readDocCount, 2);

      const cfg = loader.getConfig();
      assert.equal(cfg.about, 'Fractional CTO and AI Architect.');
      assert.deepEqual(cfg.targetRoles, ['Chief AI Officer', 'Head of Product Engineering']);
      assert.ok(cfg.rules.includes('Use TypeScript strictly'));
      assert.ok(cfg.rules.includes('Ground all metrics before asserting'));
      assert.equal(cfg.professionalRecord, 'Delivered multi-agent orchestration systems.');

      const intro = ownerIntro();
      assert.ok(intro.includes('Fractional CTO and AI Architect.'));
      assert.ok(intro.includes('• Use TypeScript strictly'));

      loader.detach();
    });

    it('buildRuntime instantiates and wires OwnerConfigLoader to UnifiedAgentRunner', () => {
      const runtime = buildRuntime({
        appDbPath: ':memory:',
        ledgerDbPath: ':memory:'
      });

      assert.ok(runtime.ownerConfigLoader, 'runtime.ownerConfigLoader must be instantiated');
      assert.equal(runtime.runner.getOwnerConfigLoader(), runtime.ownerConfigLoader, 'runner must hold ownerConfigLoader');
      assert.equal(runtime.runner.getModelRouter(), runtime.modelRouter, 'runner must hold modelRouter');
      assert.equal(runtime.runner.getMemoryRepo(), runtime.memoryRepo, 'runner must hold memoryRepo');

      runtime.dbManager.close();
    });
  });
});
