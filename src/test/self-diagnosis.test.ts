import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import {
  createSelfDiagnosisTools,
  createRepoListAndSearchTool,
  createRepoReadFileTool,
  createTraceInspectRecentTool,
  assertSafeRepoPath,
  SELF_DIAGNOSIS_TOOL_NAMES
} from '../tools/self-diagnosis.js';
import { buildStaticSystemPrompt } from '../agent/prefix-builder.js';
import { buildRuntime } from '../runtime/build-runtime.js';
import { ToolExecutionContext } from '../types/tool.js';

describe('Self-Diagnosis Module (Section 6.7)', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let ledgerRepo: ActionLedgerRepository;
  let resultStore: ResultStore;
  let runTraceStore: RunTraceStore;
  const repoRoot = path.resolve('.');

  const dummyContext: ToolExecutionContext = {
    runId: 'diag_test_run',
    isInteractive: true,
    toolGrant: {
      allowedToolNames: new Set(SELF_DIAGNOSIS_TOOL_NAMES),
      allowConsequential: true
    }
  };

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    resultStore = new ResultStore(appDb);
    runTraceStore = new RunTraceStore(appDb);
  });

  describe('repo_list_and_search', () => {
    it('lists source, skills, and package.json files safely', async () => {
      const tool = createRepoListAndSearchTool(repoRoot);
      const res: any = await tool.execute({ includeGitLog: true }, dummyContext);

      assert.ok(Array.isArray(res.files));
      assert.ok(res.files.includes('package.json'));
      assert.ok(res.files.some((f: string) => f.startsWith('src/tools/self-diagnosis.ts')));

      // Strict denial check: no .env, private/, or sqlite files in list
      assert.ok(!res.files.some((f: string) => f.includes('.env')));
      assert.ok(!res.files.some((f: string) => f.includes('private')));
      assert.ok(!res.files.some((f: string) => f.includes('.sqlite')));
      assert.ok(!res.files.some((f: string) => f.includes('node_modules')));

      // Check git log presence
      assert.ok(typeof res.gitLog === 'string');
    });

    it('filters files by pathPrefix', async () => {
      const tool = createRepoListAndSearchTool(repoRoot);
      const res: any = await tool.execute({ pathPrefix: 'src/tools' }, dummyContext);

      assert.ok(Array.isArray(res.files));
      assert.ok(res.files.length > 0);
      assert.ok(res.files.every((f: string) => f.startsWith('src/tools/')));
    });

    it('searches text query across repository files', async () => {
      const tool = createRepoListAndSearchTool(repoRoot);
      const res: any = await tool.execute({ query: 'createSelfDiagnosisTools' }, dummyContext);

      assert.ok(res.matchesCount > 0);
      assert.ok(Array.isArray(res.matches));
      const match = res.matches.find((m: any) => m.file === 'src/tools/self-diagnosis.ts');
      assert.ok(match, 'Expected match in src/tools/self-diagnosis.ts');
      assert.ok(typeof match.line === 'number');
      assert.ok(match.text.includes('createSelfDiagnosisTools'));
    });
  });

  describe('repo_read_file & Security Hard Rule', () => {
    it('reads a valid source file with line numbers and ranges', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });
      const res: any = await tool.execute({ filePath: 'package.json', startLine: 1, endLine: 5 }, dummyContext);

      assert.equal(res.filePath, 'package.json');
      assert.equal(res.startLine, 1);
      assert.equal(res.endLine, 5);
      assert.ok(res.content.includes('1: {'));
    });

    it('handles VPS path prefix /home/ellie/ellie gracefully', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });
      const res: any = await tool.execute({ filePath: '/home/ellie/ellie/package.json', startLine: 1, endLine: 3 }, dummyContext);

      assert.equal(res.filePath, 'package.json');
      assert.ok(res.content.includes('1: {'));
    });

    it('automatically routes large files (above the threshold) through ResultStore', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });
      // Read entire self-diagnosis.ts which is above the threshold
      const res: any = await tool.execute({ filePath: 'src/tools/self-diagnosis.ts' }, dummyContext);

      assert.equal(res.isStored, true);
      assert.ok(typeof res.handle === 'string' && res.handle.startsWith('res_repo_read_file'));
      assert.ok(res.preview.includes('res_repo_read_file'));

      // Verify stored content in ResultStore
      const slice = resultStore.readSlice(res.handle, { maxChars: 100 });
      assert.ok(slice.slice.length > 0);
    });

    it('SECURITY HARD RULE: strictly DENIES access to .env files', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });

      await assert.rejects(
        async () => tool.execute({ filePath: '.env' }, dummyContext),
        /\[Security Refusal\].*\.env/i
      );

      await assert.rejects(
        async () => tool.execute({ filePath: '.env.example' }, dummyContext),
        /\[Security Refusal\].*\.env/i
      );

      await assert.rejects(
        async () => tool.execute({ filePath: 'src/../.env' }, dummyContext),
        /\[Security Refusal\].*\.env/i
      );
    });

    it('SECURITY HARD RULE: strictly DENIES access to private directory', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });

      await assert.rejects(
        async () => tool.execute({ filePath: 'private/routines.json' }, dummyContext),
        /\[Security Refusal\].*private/i
      );

      await assert.rejects(
        async () => tool.execute({ filePath: 'src/../private/routines.json' }, dummyContext),
        /\[Security Refusal\].*private/i
      );
    });

    it('SECURITY HARD RULE: strictly DENIES access to .sqlite files', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });

      await assert.rejects(
        async () => tool.execute({ filePath: 'app.sqlite' }, dummyContext),
        /\[Security Refusal\].*sqlite/i
      );
    });

    it('SECURITY HARD RULE: strictly DENIES paths outside repository root', async () => {
      const tool = createRepoReadFileTool({ repoRoot, resultStore });

      await assert.rejects(
        async () => tool.execute({ filePath: '../../../../../../etc/passwd' }, dummyContext),
        /\[Security Refusal\].*outside repository root/i
      );
    });
  });

  describe('trace_inspect_recent', () => {
    it('queries recent run traces and returns exact tool params, results, and errors', async () => {
      // Record a run in runTraceStore
      runTraceStore.recordRun('slack_dm', 'why did that fail?', {
        runId: 'trace_run_1',
        status: 'FAILED',
        output: { deliveryMode: 'SLACK_MESSAGE', coworkerHeadline: 'Error encountered' },
        toolCallsExecuted: [
          {
            tool: 'google_sheets_read',
            params: { spreadsheetId: 'sheet123', range: 'A1:B10' },
            result: { error: 'Spreadsheet not found' },
            durationMs: 85
          }
        ],
        handlesCreated: [],
        telemetry: {
          promptTokens: 100,
          cachedTokens: 0,
          thinkingTokens: 10,
          candidatesTokens: 10,
          totalTokens: 120,
          model: 'gemini-3.8-flash',
          durationMs: 95
        },
        wallMs: 180,
        error: 'Spreadsheet not found'
      });

      // Stage an action in actionLedger
      const action = ledgerRepo.stageProposal({
        actionId: 'act_trace_1',
        actionType: 'gmail_send',
        payload: { to: 'test@example.com', subject: 'Diagnostic test' }
      });
      ledgerRepo.denyAction(action.id, 'owner', 'Cancelled during test');

      const tool = createTraceInspectRecentTool({ appDb, ledgerDb });
      const res: any = await tool.execute({ limit: 5, includeLedger: true }, dummyContext);

      assert.equal(res.runTracesCount, 1);
      const trace = res.runTraces[0];
      assert.equal(trace.runId, 'trace_run_1');
      assert.equal(trace.status, 'FAILED');
      assert.equal(trace.error, 'Spreadsheet not found');
      assert.equal(trace.toolsCalled.length, 1);
      assert.equal(trace.toolsCalled[0].tool, 'google_sheets_read');
      assert.deepEqual(trace.toolsCalled[0].params, { spreadsheetId: 'sheet123', range: 'A1:B10' });
      assert.deepEqual(trace.toolsCalled[0].result, { error: 'Spreadsheet not found' });

      // Action ledger verification
      assert.equal(res.actionsCount, 1);
      const act = res.stagedOrExecutedActions[0];
      assert.equal(act.actionId, 'act_trace_1');
      assert.equal(act.state, 'DENIED');
      assert.deepEqual(act.payload, { to: 'test@example.com', subject: 'Diagnostic test' });
      assert.ok(act.events.length >= 2); // STAGED and DENIED
    });

    it('returns a digest: errors in full, other results as a short preview or handle', async () => {
      const letter = 'Dear Hiring Team, '.repeat(2000);
      runTraceStore.recordRun('slack_dm', 'write a letter', {
        runId: 'trace_run_big',
        status: 'COMPLETED',
        output: { deliveryMode: 'SLACK_MESSAGE' },
        toolCallsExecuted: [
          { tool: 'made_up_source_read', params: { id: 'x' }, result: { isStored: true, handle: 'res_made_up_1', preview: letter }, durationMs: 1 },
          { tool: 'made_up_draft_check', params: { text: letter }, result: { text: letter }, durationMs: 1 },
          { tool: 'made_up_write', params: { id: 'y' }, result: { error: `Refused: ${'detail '.repeat(100)}` }, durationMs: 1 }
        ],
        handlesCreated: [],
        telemetry: { promptTokens: 10, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 10, totalTokens: 20, model: 'gemini-3.8-flash', durationMs: 5 },
        wallMs: 5
      });
      const tool = createTraceInspectRecentTool({ appDb, ledgerDb });
      const res: any = await tool.execute({ limit: 1, includeLedger: false }, dummyContext);
      const calls = res.runTraces[0].toolsCalled;
      assert.deepEqual(calls[0].result, { handle: 'res_made_up_1' });
      assert.ok(calls[1].params.length <= 301 && calls[1].result.length <= 301);
      assert.match(calls[2].result.error, /^Refused: (detail ){100}$/);
      assert.ok(JSON.stringify(res).length < 3000, `digest stays small: ${JSON.stringify(res).length}`);
    });

    it('filters by errorsOnly', async () => {
      runTraceStore.recordRun('routine', 'healthy routine', {
        runId: 'trace_run_clean',
        status: 'COMPLETED',
        output: { deliveryMode: 'SILENT' },
        toolCallsExecuted: [],
        handlesCreated: [],
        telemetry: { promptTokens: 10, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 10, totalTokens: 20, model: 'gemini-3.8-flash', durationMs: 50 },
        wallMs: 50
      });

      const tool = createTraceInspectRecentTool({ appDb, ledgerDb });
      const res: any = await tool.execute({ limit: 5, errorsOnly: true }, dummyContext);

      assert.equal(res.runTracesCount, 0);
    });
  });

  describe('Self-Diagnosis Rule (Section 6.7) in System Prompt', () => {
    it('contains Section 6.7 rule with exact diagnosis instructions', () => {
      const prompt = buildStaticSystemPrompt();
      assert.ok(prompt.includes('SECTION 6.7'), 'Expected SECTION 6.7 in system prompt');
      assert.ok(prompt.includes('trace_inspect_recent'));
      assert.ok(prompt.includes('repo_read_file'));
      assert.ok(prompt.includes('(A) An Ellie/Skill Fix'));
      assert.ok(prompt.includes('(B) A Code Fix'));
      assert.ok(prompt.includes('Antigravity'));
    });
  });

  describe('Runtime Registration', () => {
    it('registers all 3 self-diagnosis tools as READ tools in buildRuntime', () => {
      const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
      for (const toolName of SELF_DIAGNOSIS_TOOL_NAMES) {
        const tool = runtime.dispatcher.getTool(toolName);
        assert.ok(tool, `Expected tool '${toolName}' to be registered in runtime dispatcher.`);
        assert.equal(tool.effectClass, 'READ', `Expected tool '${toolName}' to have effectClass READ.`);
      }
    });
  });
});
