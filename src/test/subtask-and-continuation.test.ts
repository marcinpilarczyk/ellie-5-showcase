import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { createSubtaskTools } from '../tools/subtask-tool.js';
import { ToolDefinition } from '../types/tool.js';

const telemetry = { promptTokens: 100, cachedTokens: 50, thinkingTokens: 10, candidatesTokens: 20, totalTokens: 130, durationMs: 15, model: 'test' };

function scriptedModel(script: Array<Array<{ name: string; args?: any }> | Error>) {
  const requests: Array<{ contents: any[]; config: any }> = [];
  return {
    requests,
    router: {
      modelName: 'test',
      generate: async (contents: any[], config: any) => {
        requests.push({ contents: JSON.parse(JSON.stringify(contents)), config });
        const step = script[Math.min(requests.length - 1, script.length - 1)];
        if (step instanceof Error) throw step;
        return { text: '', functionCalls: step.map(c => ({ name: c.name, args: c.args || {} })), telemetry, rawResponse: {} };
      }
    } as any
  };
}

describe('Agentic Sub-Rounds (delegate_subtask)', () => {
  it('executes a subtask child round and returns synthesized deliverable to parent', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const resultStore = new ResultStore(appDb);
    const dispatcher = new ToolDispatcher(undefined, resultStore);

    const webSearch: ToolDefinition = {
      name: 'web_search',
      description: 'search',
      effectClass: 'READ',
      schema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ results: [`Market analysis for ${query}`] })
    };
    dispatcher.registerTool(webSearch);

    // Multi-turn scripted model:
    // Call 1 (parent): calls delegate_subtask
    // Call 2 (child subtask round 1): child calls web_search
    // Call 3 (child subtask round 2): child finishes with DONE
    // Call 4 (parent round 2): parent receives subtask deliverable and finishes
    let callCount = 0;
    const model = {
      modelName: 'test',
      generate: async (contents: any[], config: any) => {
        callCount++;
        if (callCount === 1) {
          // Parent delegating subtask
          return {
            text: '',
            functionCalls: [{
              name: 'delegate_subtask',
              args: { task: 'Investigate competitor pricing', expected_output: 'Price range table' }
            }],
            telemetry,
            rawResponse: {}
          };
        }
        if (callCount === 2) {
          // Child subtask executing web_search
          return {
            text: '',
            functionCalls: [{
              name: 'web_search',
              args: { query: 'competitor pricing' }
            }],
            telemetry,
            rawResponse: {}
          };
        }
        if (callCount === 3) {
          // Child subtask finishes
          return {
            text: '',
            functionCalls: [{
              name: 'finish',
              args: { status: 'DONE', message: 'Pricing ranges between $49 and $199/month.' }
            }],
            telemetry,
            rawResponse: {}
          };
        }
        // Parent finishes after seeing subtask result
        return {
          text: '',
          functionCalls: [{
            name: 'finish',
            args: { status: 'DONE', message: 'Analysis complete: pricing is $49-$199/mo.' }
          }],
          telemetry,
          rawResponse: {}
        };
      }
    };

    const runner = new UnifiedAgentRunner(model as any, dispatcher);
    dispatcher.registerTool(createSubtaskTools(runner, resultStore)[0]);

    const res = await runner.run({
      trigger: 'slack_dm',
      instruction: 'Run competitor research',
      isInteractive: true,
      toolGrant: {
        allowedToolNames: new Set(['delegate_subtask', 'web_search']),
        allowConsequential: false
      }
    });

    assert.equal(res.status, 'COMPLETED');
    assert.equal(res.output.finishStatus, 'DONE');
    assert.equal(res.output.slackMessage, 'Analysis complete: pricing is $49-$199/mo.');
    assert.equal(callCount, 4);

    // Verify subtask tool record in parent run
    const subtaskCall = res.toolCallsExecuted.find(tc => tc.tool === 'delegate_subtask');
    assert.ok(subtaskCall);
    assert.equal(subtaskCall.result.status, 'COMPLETED');
    assert.match(subtaskCall.result.deliverable, /Pricing ranges between/);
    assert.deepEqual(subtaskCall.result.toolsCalled, ['web_search']);
  });

  it('strictly refuses recursive nesting (subtask cannot call delegate_subtask)', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const dispatcher = new ToolDispatcher();
    const runner = new UnifiedAgentRunner({ modelName: 'test', generate: async () => ({ text: '', functionCalls: [], telemetry, rawResponse: {} }) } as any, dispatcher);
    const [subtaskTool] = createSubtaskTools(runner);

    const context: any = {
      runId: 'subtask_123',
      subtaskDepth: 1, // Already inside a subtask
      toolGrant: { allowedToolNames: new Set(['delegate_subtask']), allowConsequential: false }
    };

    const result = await subtaskTool.execute({ task: 'inner task' }, context);
    assert.equal(result.status, 'REFUSED');
    assert.match(result.error, /Subtask nesting limit reached/);
  });

  it('keeps large subtask output in ResultStore under a handle', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const resultStore = new ResultStore(appDb);
    const dispatcher = new ToolDispatcher(undefined, resultStore);

    const largeReport = 'Detailed analysis:\n' + 'A'.repeat(2500);

    let callCount = 0;
    const model = {
      modelName: 'test',
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            functionCalls: [{ name: 'delegate_subtask', args: { task: 'Deep research' } }],
            telemetry,
            rawResponse: {}
          };
        }
        if (callCount === 2) {
          return {
            text: '',
            functionCalls: [{ name: 'finish', args: { status: 'DONE', message: largeReport } }],
            telemetry,
            rawResponse: {}
          };
        }
        return {
          text: '',
          functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Report received.' } }],
          telemetry,
          rawResponse: {}
        };
      }
    };

    const runner = new UnifiedAgentRunner(model as any, dispatcher);
    dispatcher.registerTool(createSubtaskTools(runner, resultStore)[0]);

    const res = await runner.run({
      trigger: 'slack_dm',
      instruction: 'Do research',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['delegate_subtask']), allowConsequential: false }
    });

    const subtaskCall = res.toolCallsExecuted.find(tc => tc.tool === 'delegate_subtask');
    assert.ok(subtaskCall);
    assert.ok(subtaskCall.result.handle, 'Large subtask deliverable must produce a ResultStore handle');
    const stored = resultStore.get(subtaskCall.result.handle);
    assert.ok(stored);
    assert.equal(stored.content, largeReport);
  });
});

describe('Background Continuation for Long Interactive Work', () => {
  it('triggers background continuation on CONTINUE_IN_BACKGROUND and delivers to thread', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    const ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const resultStore = new ResultStore(appDb);
    const carryover = new ThreadCarryoverRepository(appDb, resultStore);
    const dispatcher = new ToolDispatcher(ledgerRepo, resultStore);

    const mockTool: ToolDefinition = {
      name: 'data_crunch',
      description: 'crunch data',
      effectClass: 'READ',
      schema: z.object({ slice: z.number() }),
      execute: async ({ slice }) => ({ slice, status: 'processed' })
    };
    dispatcher.registerTool(mockTool);

    // Call 1: interactive turn crunches slice 1, then finishes with CONTINUE_IN_BACKGROUND
    // Call 2: background continuation crunches slice 2, then finishes with DONE
    let callCount = 0;
    const model = {
      modelName: 'test',
      generate: async (contents: any[], config: any) => {
        callCount++;
        if (callCount === 1) {
          return {
            text: '',
            functionCalls: [{ name: 'data_crunch', args: { slice: 1 } }],
            telemetry,
            rawResponse: {}
          };
        }
        if (callCount === 2) {
          return {
            text: '',
            functionCalls: [{
              name: 'finish',
              args: {
                status: 'CONTINUE_IN_BACKGROUND',
                message: '⏳ Processing slice 1. Continuing remaining slices in the background...'
              }
            }],
            telemetry,
            rawResponse: {}
          };
        }
        if (callCount === 3) {
          // Continuation call 1
          return {
            text: '',
            functionCalls: [{ name: 'data_crunch', args: { slice: 2 } }],
            telemetry,
            rawResponse: {}
          };
        }
        // Continuation finishes with DONE
        return {
          text: '',
          functionCalls: [{
            name: 'finish',
            args: { status: 'DONE', message: 'All slices successfully crunched and verified.' }
          }],
          telemetry,
          rawResponse: {}
        };
      }
    };

    const runner = new UnifiedAgentRunner(model as any, dispatcher);
    const postedMessages: any[] = [];
    const addedReactions: string[] = [];
    const removedReactions: string[] = [];

    const mockSlack: any = {
      isConfigured: () => true,
      defaultChannel: 'C_TEST',
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
        return { ok: true, ts: `msg_${Date.now()}` };
      },
      addReaction: async (r: any) => {
        addedReactions.push(r.name);
        return { ok: true };
      },
      removeReaction: async (r: any) => {
        removedReactions.push(r.name);
        return { ok: true };
      },
      getConversationReplies: async () => []
    };

    const coworker = new SlackCoworkerService(
      mockSlack,
      ledgerRepo,
      runner,
      undefined,
      async () => ({ ok: true, status: 'VERIFIED', message: 'done', outcome: 'VERIFIED_SUCCESS' } as any),
      carryover
    );

    const event: any = {
      type: 'message',
      channel: 'C_TEST',
      ts: '100.1',
      thread_ts: '100.1',
      text: 'Crunch all large data',
      user: 'U_OWNER'
    };

    await coworker.handleUserMessage(event);

    // Initial message delivered
    assert.ok(postedMessages.length >= 1);
    assert.match(postedMessages[0].text, /Continuing remaining slices in the background/);

    // Background continuation executed asynchronously
    assert.equal(callCount, 4);

    // Final message delivered to the same thread
    const finalMsg = postedMessages[postedMessages.length - 1];
    assert.equal(finalMsg.thread_ts, '100.1');
    assert.match(finalMsg.text, /All slices successfully crunched/);

    // Verify carryover in thread contains final result
    const threadWork = carryover.get('C_TEST:100.1');
    assert.ok(threadWork);
    assert.match(threadWork, /All slices successfully crunched/);
  });

  it('stages consequential actions during background continuation with approval cards', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    const ledgerRepo = new ActionLedgerRepository(ledgerDb);
    const dispatcher = new ToolDispatcher(ledgerRepo);

    const sendEmail: ToolDefinition = {
      name: 'made_up_send',
      description: 'send an email',
      effectClass: 'CONSEQUENTIAL',
      schema: z.object({ to: z.string(), body: z.string() }),
      execute: async () => ({ sent: true })
    };
    dispatcher.registerTool(sendEmail);

    let callCount = 0;
    const model = {
      modelName: 'test',
      generate: async () => {
        callCount++;
        if (callCount === 1) {
          // Interactive turn finishes with CONTINUE_IN_BACKGROUND
          return {
            text: '',
            functionCalls: [{
              name: 'finish',
              args: { status: 'CONTINUE_IN_BACKGROUND', message: 'Continuing outreach in background...' }
            }],
            telemetry,
            rawResponse: {}
          };
        }
        if (callCount === 2) {
          // Background continuation stages consequential send
          return {
            text: '',
            functionCalls: [{
              name: 'made_up_send',
              args: { to: 'colleague@example.com', body: 'Project update notes' }
            }],
            telemetry,
            rawResponse: {}
          };
        }
        // Background continuation finishes
        return {
          text: '',
          functionCalls: [{
            name: 'finish',
            args: { status: 'DONE', message: 'Staged outreach email for approval.' }
          }],
          telemetry,
          rawResponse: {}
        };
      }
    };

    const runner = new UnifiedAgentRunner(model as any, dispatcher);
    const postedMessages: any[] = [];

    const mockSlack: any = {
      isConfigured: () => true,
      defaultChannel: 'C_TEST',
      postMessage: async (msg: any) => {
        postedMessages.push(msg);
        return { ok: true, ts: `card_${Date.now()}` };
      },
      addReaction: async () => ({ ok: true }),
      removeReaction: async () => ({ ok: true }),
      getConversationReplies: async () => []
    };

    const coworker = new SlackCoworkerService(
      mockSlack,
      ledgerRepo,
      runner,
      undefined,
      async () => ({ ok: true, status: 'VERIFIED', message: 'done', outcome: 'VERIFIED_SUCCESS' } as any)
    );

    const event: any = {
      type: 'message',
      channel: 'C_TEST',
      ts: '200.1',
      thread_ts: '200.1',
      text: 'Prepare outreach batch',
      user: 'U_OWNER'
    };

    await coworker.handleUserMessage(event);

    // Consequential action was staged in the ledger
    const staged = ledgerRepo.listStaged();
    assert.equal(staged.length, 1);
    assert.equal(staged[0].action_type, 'made_up_send');

    // Quote card with blocks was posted to Slack thread
    const cardMsg = postedMessages.find(m => m.blocks && m.blocks.length > 0);
    assert.ok(cardMsg);
    assert.equal(cardMsg.thread_ts, '200.1');
  });
});
