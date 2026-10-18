import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { OwnerSources } from '../tools/owner-source-tools.js';
import { ResultStore } from '../storage/result-store.js';
import { CostRepository } from '../storage/cost-repo.js';
import { createApifyTools } from '../tools/social-tools.js';
import { GmailSentinel } from '../scheduler/sentinels/gmail-sentinel.js';
import { CalendarSentinel } from '../scheduler/sentinels/calendar-sentinel.js';
import { ProtonSentinel } from '../scheduler/sentinels/proton-sentinel.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { SlackClient } from '../integrations/slack/client.js';
import { NudgeGate } from '../scheduler/nudge-gate.js';
import { ModelRouter } from '../models/model-router.js';
import { createOwnerTextCheckTool } from '../tools/owner-text-check-tool.js';
import { ToolDispatcher } from '../governance/dispatcher.js';

describe('Optimizations & Hardening (Phases 1-3)', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
  });

  describe('Phase 1: OwnerSources SQLite Cache', () => {
    it('uses SQLite cached doc when modified_time has not changed', async () => {
      let readDocCount = 0;
      let folderList = [{ id: 'doc1', title: 'Resume', path: '', modifiedTime: '2026-01-01T10:00:00Z' }];

      const deps = {
        folderId: async () => 'folder-1',
        listDocs: async () => folderList,
        readDoc: async (id: string) => {
          readDocCount++;
          return `Content of ${id}`;
        },
        linkedDocIds: () => []
      };

      // Pass ttlMs = 0 so we specifically test the SQLite persistent cache logic
      const sources = new OwnerSources(deps, 0, appDb);

      // First run: cache is empty, readDoc must be called
      const firstRun = await sources.documents();
      assert.equal(firstRun.docs.length, 1);
      assert.equal(readDocCount, 1);
      assert.equal(firstRun.docs[0].text, 'Content of doc1');

      // Second run: same modified_time, should serve from SQLite cache (0 new readDoc calls)
      const secondRun = await sources.documents();
      assert.equal(secondRun.docs.length, 1);
      assert.equal(readDocCount, 1); // Still 1!
      assert.equal(secondRun.docs[0].text, 'Content of doc1');

      // Third run: modified_time updated, readDoc must be called again
      folderList = [{ id: 'doc1', title: 'Resume', path: '', modifiedTime: '2026-01-02T10:00:00Z' }];
      const thirdRun = await sources.documents();
      assert.equal(thirdRun.docs.length, 1);
      assert.equal(readDocCount, 2);
    });
  });

  describe('Phase 1: Structured Document Blocks in owner_text_check', () => {
    it('checks blocks and stores valid blocks as draftHandle', async () => {
      const claimsGuard = new ClaimsBankGuard(
        async () => '# Claims Bank\n1. Built high scale systems. [V]',
        60_000,
        async () => ({ texts: ['Career record: Jan Kowalski built high scale systems.'], missing: [] })
      );
      process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';

      const tool = createOwnerTextCheckTool(claimsGuard);
      const blocksInput = [
        { type: 'heading', text: 'Jan Kowalski' },
        { type: 'paragraph', text: 'Built high scale systems.' }
      ];

      const dummyContext: any = {
        runId: 'run-blocks-1',
        isInteractive: true,
        ownerSourcesRead: true,
        toolGrant: { allowedToolNames: new Set(['owner_text_check', 'document_render']), allowConsequential: false }
      };

      const res = await tool.execute({
        kind: 'document',
        blocks: blocksInput
      }, dummyContext);

      assert.equal(res.status, 'CLEAN_TO_WRITE');
      assert.equal(res.wouldBeWritten, true);

      // Verify dispatcher can register and dispatch a tool with blocks
      const dispatcher = new ToolDispatcher(
        new ActionLedgerRepository(ledgerDb),
        new ResultStore(appDb),
        claimsGuard
      );

      let renderedBlocks: any = null;
      dispatcher.registerTool({
        name: 'document_render',
        description: 'renders document',
        effectClass: 'INTERNAL_REVERSIBLE_WRITE',
        schema: (tool.schema as any),
        ownerText: { kind: 'document', field: 'blocks', text: () => '' },
        execute: async (p: any) => {
          renderedBlocks = p.blocks;
          return { ok: true };
        }
      });

      await dispatcher.dispatch('document_render', { kind: 'document', blocks: blocksInput }, dummyContext);
      assert.ok(Array.isArray(renderedBlocks));
      assert.equal(renderedBlocks.length, 2);
    });
  });

  describe('Phase 2: Apify Spend Cap & Bearer Header', () => {
    it('enforces ELLIE_APIFY_MAX_DAILY_CALLS and returns BUDGET_EXHAUSTED', async () => {
      process.env.APIFY_API_TOKEN = 'test-token';
      process.env.ELLIE_APIFY_MAX_DAILY_CALLS = '2';

      const costRepo = new CostRepository(appDb);
      const apifyTools = createApifyTools(costRepo);
      const profileTool = apifyTools.find(t => t.name === 'apify_linkedin_profile')!;

      // Simulate 2 previous calls today
      costRepo.recordUsage({
        model: 'apify-actor',
        source: 'apify',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      });
      costRepo.recordUsage({
        model: 'apify-actor',
        source: 'apify',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      });

      const dummyContext: any = {
        runId: 'run-apify-test',
        isInteractive: true,
        toolGrant: { allowedToolNames: new Set(['apify_linkedin_profile']), allowConsequential: false }
      };

      const res: any = await profileTool.execute({ profileUrl: 'https://www.linkedin.com/in/test' }, dummyContext);
      assert.equal(res.status, 'BUDGET_EXHAUSTED');
      assert.ok(res.message.includes('Daily Apify budget cap reached'));
    });
  });

  describe('Phase 2: Sentinels Honest Statuses & Claims Verification', () => {
    it('returns off / not_connected honest statuses', async () => {
      const ledgerRepo = new ActionLedgerRepository(ledgerDb);
      const routineRepo = new RoutineRepository(appDb);
      const slackClient = new SlackClient();
      const nudgeGate = new NudgeGate(appDb);
      const modelRouter = new ModelRouter(new CostRepository(appDb));

      const unconfiguredGoogle = {
        isConnected: () => false
      };

      const gmail = new GmailSentinel(unconfiguredGoogle as any, modelRouter, ledgerRepo, routineRepo, slackClient, nudgeGate);
      const res = await gmail.runCheck();
      assert.equal(res.status, 'not_connected');

      const cal = new CalendarSentinel(unconfiguredGoogle as any, modelRouter, routineRepo, slackClient, nudgeGate);
      const calRes = await cal.runCheck();
      assert.equal(calRes.status, 'not_connected');

      const unconfiguredProton = {
        isEnabled: () => false
      };
      const proton = new ProtonSentinel(unconfiguredProton as any, modelRouter, ledgerRepo, routineRepo, slackClient, nudgeGate);
      const protonRes = await proton.runCheck();
      assert.equal(protonRes.status, 'not_connected');
    });
  });

  describe('Phase 3: Database Maintenance (pruneOldResults)', () => {
    it('prunes expired results while preserving those referenced in thread_carryover', () => {
      const resultStore = new ResultStore(appDb);

      // Insert 3 tool_results manually with old created_at
      appDb.prepare(`
        INSERT INTO tool_results (handle, run_id, tool_name, content, preview, size_bytes, created_at)
        VALUES ('h-old-1', 'run-1', 'web_search', 'content 1', 'prev 1', 10, datetime('now', '-20 days')),
               ('h-old-referenced', 'run-2', 'web_search', 'content 2', 'prev 2', 10, datetime('now', '-20 days')),
               ('h-fresh', 'run-3', 'web_search', 'content 3', 'prev 3', 10, datetime('now', '-2 days'))
      `).run();

      // Reference 'h-old-referenced' in thread_carryover entries_json
      appDb.prepare(`
        INSERT INTO thread_carryover (thread_key, run_id, summary, updated_at, entries_json)
        VALUES ('thread-1', 'run-2', 'summary', datetime('now'), ?)
      `).run(JSON.stringify([{ handle: 'h-old-referenced', tool: 'web_search' }]));

      // Prune with 14 day retention
      const pruned = resultStore.pruneOldResults(14);
      assert.equal(pruned, 1);

      // Verify h-old-1 was pruned, but h-old-referenced and h-fresh remain
      const remaining = appDb.prepare('SELECT handle FROM tool_results ORDER BY handle ASC').all() as Array<{ handle: string }>;
      assert.deepEqual(remaining.map(r => r.handle), ['h-fresh', 'h-old-referenced']);
    });
  });
});
