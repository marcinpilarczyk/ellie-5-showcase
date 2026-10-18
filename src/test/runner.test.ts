import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import * as schema from '../storage/schema.js';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelTier, ModelCallConfig, ModelCallResponse } from '../models/model-router.js';
import { ToolDefinition } from '../types/tool.js';

describe('UnifiedAgentRunner', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let ledgerRepo: ActionLedgerRepository;
  let resultStore: ResultStore;
  let runTraceStore: RunTraceStore;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    resultStore = new ResultStore(appDb);
    runTraceStore = new RunTraceStore(appDb);
    dispatcher = new ToolDispatcher(ledgerRepo, resultStore);
  });

  it('runs simple reversible request and returns REACTION_ONLY delivery', async () => {
    // Mock router returning JSON conforming to UNIFIED_RESPONSE_SCHEMA
    const mockRouter = {
      generate: async () => ({
        text: JSON.stringify({
          deliveryMode: 'REACTION_ONLY',
          reactionEmoji: 'white_check_mark',
          summary: 'Added reminder silently'
        }),
        functionCalls: [],
        telemetry: {
          model: 'gemini-3.8-flash',
          promptTokens: 100,
          cachedTokens: 50,
          thinkingTokens: 20,
          candidatesTokens: 30,
          totalTokens: 200,
          durationMs: 150
        }
      })
    } as unknown as ModelRouter;

    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, runTraceStore);

    const result = await runner.run({
      runId: 'test_react_run',
      trigger: 'slack_dm',
      instruction: 'remind me to check email tomorrow',
      toolGrant: { allowedToolNames: new Set(), allowConsequential: false }
    });

    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.output.deliveryMode, 'REACTION_ONLY');
    assert.equal(result.output.reactionEmoji, 'white_check_mark');

    // Verify glass-box trace recorded in run_traces table
    const trace = runTraceStore.getTrace('test_react_run');
    assert.ok(trace !== null);
    assert.equal(trace.delivery_mode, 'REACTION_ONLY');
  });

  it('escalates to high thinking tier when two tool failures occur consecutively', async () => {
    let callCount = 0;
    const tiersUsed: ModelTier[] = [];

    // Failing tool
    const failingTool: ToolDefinition = {
      name: 'broken_tool',
      description: 'Always fails',
      schema: z.object({}),
      effectClass: 'READ',
      execute: async () => {
        throw new Error('Connection refused');
      }
    };
    dispatcher.registerTool(failingTool);

    const mockRouter = {
      generate: async (_contents: any[], options: ModelCallConfig): Promise<ModelCallResponse> => {
        callCount++;
        tiersUsed.push(options.tier);

        if (callCount <= 2) {
          // Model attempts calling the broken tool with different retry attempts
          return {
            text: '',
            functionCalls: [{ name: 'broken_tool', args: { attempt: callCount } }],
            telemetry: { model: 'gemini-3.8-flash', promptTokens: 50, cachedTokens: 0, thinkingTokens: 10, candidatesTokens: 10, totalTokens: 70, durationMs: 100 }
          };
        }

        // Round 3: Model yields final recovery output
        return {
          text: JSON.stringify({
            deliveryMode: 'SLACK_MESSAGE',
            coworkerHeadline: 'Could not access the remote endpoint.',
            slackMessage: 'Tool failed 2 times, gracefully stopping.',
            summary: 'Graceful degradation'
          }),
          functionCalls: [],
          telemetry: { model: 'gemini-3.8-flash', promptTokens: 60, cachedTokens: 0, thinkingTokens: 20, candidatesTokens: 20, totalTokens: 100, durationMs: 150 }
        };
      }
    } as unknown as ModelRouter;

    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, runTraceStore);

    const result = await runner.run({
      runId: 'test_escalate_run',
      trigger: 'routine',
      instruction: 'Fetch daily sync from broken tool',
      tier: 'ROUTINE',
      toolGrant: { allowedToolNames: new Set(['broken_tool']), allowConsequential: false }
    });

    assert.equal(result.status, 'COMPLETED');
    // Verify that after 2 failures, currentTier escalated to ESCALATION (HIGH thinking)
    assert.ok(tiersUsed.includes('ESCALATION'), `Expected ESCALATION tier to be used. Tiers used: ${tiersUsed.join(', ')}`);
    assert.equal(result.output.deliveryMode, 'SLACK_MESSAGE');
  });

  it('records wall-clock duration including tool time, with model time kept separately', async () => {
    // Any slow tool: the trace must count its time, not just the model's
    dispatcher.registerTool({
      name: 'slow_lookup',
      description: 'Takes a while',
      schema: z.object({}),
      effectClass: 'READ',
      execute: async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return { ok: true };
      }
    });

    let call = 0;
    const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 10 };
    const mockRouter = {
      generate: async (): Promise<ModelCallResponse> => {
        call++;
        return call === 1
          ? { text: '', functionCalls: [{ name: 'slow_lookup', args: {} }], telemetry }
          : { text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Found it.' } }], telemetry };
      }
    } as unknown as ModelRouter;

    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, runTraceStore);
    const result = await runner.run({
      runId: 'test_wall_clock_run',
      trigger: 'manual',
      instruction: 'look it up',
      toolGrant: { allowedToolNames: new Set(['slow_lookup']), allowConsequential: false }
    });

    assert.equal(result.telemetry.durationMs, 20);
    assert.ok(result.wallMs >= 300, `wallMs ${result.wallMs} should include the 300 ms tool call`);

    const trace = runTraceStore.getTrace('test_wall_clock_run')!;
    assert.equal(trace.model_ms, 20);
    assert.equal(trace.duration_ms, result.wallMs);
  });

  it('records a handle only for results the Result Store took, not for readers that echo one', async () => {
    dispatcher.registerTool({
      name: 'made_up_big_read', description: 'Big', schema: z.object({}), effectClass: 'READ',
      execute: async () => ({ body: 'z'.repeat(7000) })
    });
    dispatcher.registerTool({
      name: 'made_up_reader', description: 'Reads a handle', schema: z.object({ handle: z.string() }), effectClass: 'READ',
      execute: async (p: any) => ({ handle: p.handle, slice: 'Requirements: fluent Polish' })
    });

    let call = 0;
    const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };
    let storedHandle = '';
    const mockRouter = {
      generate: async (contents: any[]): Promise<ModelCallResponse> => {
        call++;
        if (call === 1) return { text: '', functionCalls: [{ name: 'made_up_big_read', args: {} }], telemetry };
        if (call === 2) {
          storedHandle = contents.at(-1).parts[0].functionResponse.response.result.handle;
          return { text: '', functionCalls: [{ name: 'made_up_reader', args: { handle: storedHandle } }], telemetry };
        }
        return { text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Done.' } }], telemetry };
      }
    } as unknown as ModelRouter;

    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, runTraceStore);
    const result = await runner.run({
      runId: 'test_handles_run',
      trigger: 'manual',
      instruction: 'read it',
      toolGrant: { allowedToolNames: new Set(['made_up_big_read', 'made_up_reader']), allowConsequential: false }
    });

    assert.deepEqual(result.handlesCreated, [storedHandle]);
    assert.equal(result.toolCallsExecuted[0].handle, storedHandle);
    assert.equal(result.toolCallsExecuted[1].handle, undefined, 'the reader created nothing');

    const summary = ThreadCarryoverRepository.summarize(result);
    assert.match(summary, /made_up_big_read\(\{\}\) -> stored as handle/);
    assert.match(summary, /made_up_reader\(.*\) -> .*Requirements: fluent Polish/);
  });

  it('migration 2 keeps the old summed model time as model_ms', () => {
    const db = new DatabaseSync(':memory:');
    const { migrate, APP_MIGRATIONS } = schema;
    migrate(db, APP_MIGRATIONS.filter(m => m.version === 1), 'app');
    db.prepare("INSERT INTO run_traces (run_id, trigger, status, delivery_mode, duration_ms) VALUES ('old', 'slack_dm', 'COMPLETED', 'SLACK_MESSAGE', 35426)").run();
    migrate(db, APP_MIGRATIONS, 'app');
    const row = db.prepare("SELECT duration_ms, model_ms FROM run_traces WHERE run_id = 'old'").get() as any;
    assert.equal(row.model_ms, 35426);
  });
});
