import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { createRoutineTools } from '../tools/routine-tools.js';
import { tierForRoutine } from '../scheduler/routine-worker.js';
import {
  ModelRouter, ModelTier, ModelCallConfig, ModelCallResponse,
  explicitReasoningRequest, reasoningRequestedInThread
} from '../models/model-router.js';

const finishRouter = (tiers: ModelTier[]) => ({
  generate: async (_c: any[], o: ModelCallConfig): Promise<ModelCallResponse> => {
    tiers.push(o.tier);
    return {
      text: '',
      functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'ok' } }],
      telemetry: { model: 'm', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 }
    };
  }
}) as unknown as ModelRouter;

describe('explicit reasoning-model requests', () => {
  it('detects a request by name and respects refusals', () => {
    assert.ok(explicitReasoningRequest('make a tailored resume using Argon'));
    assert.ok(explicitReasoningRequest('użyj argona do tego'));
    assert.ok(explicitReasoningRequest('with the reasoning model please'));
    assert.ok(!explicitReasoningRequest("don't use argon for this"));
    assert.ok(!explicitReasoningRequest('flash only, and mention argon is slow'));
    assert.ok(!explicitReasoningRequest('what is on my calendar tomorrow?'));
  });

  it('is sticky in a thread until the owner says otherwise', () => {
    assert.ok(reasoningRequestedInThread('continue', ['resume with argon', 'continue']));
    assert.ok(!reasoningRequestedInThread('continue', ['resume with argon', 'ok, flash only now']));
    assert.ok(!reasoningRequestedInThread('continue', ['hello']));
  });

  it('puts an Argon run on the ANALYSIS tier and keeps it there after tool failures', async () => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    const dispatcher = new ToolDispatcher(new ActionLedgerRepository(ledgerDb), new ResultStore(appDb));
    const tiers: ModelTier[] = [];
    const runner = new UnifiedAgentRunner(finishRouter(tiers), dispatcher);
    const grant = { allowedToolNames: new Set<string>(), allowConsequential: false };

    await runner.run({ trigger: 'slack_dm', isInteractive: true, instruction: 'draft the memo with argon', toolGrant: grant });
    await runner.run({
      trigger: 'slack_dm', isInteractive: true, instruction: 'continue', toolGrant: grant,
      conversationHistory: [{ role: 'user', parts: [{ text: 'draft the memo with argon' }] }, { role: 'model', parts: [{ text: 'on it' }] }]
    });
    await runner.run({ trigger: 'slack_dm', isInteractive: true, instruction: 'what is on my calendar?', toolGrant: grant });
    assert.deepEqual(tiers, ['ANALYSIS', 'ANALYSIS', 'INTERACTIVE']);
  });

  it('routine_manage sets and switches a routine model, and the worker picks the tier from it', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const repo = new RoutineRepository(appDb);
    const [tool] = createRoutineTools(repo);
    const ctx: any = { runId: 'r', isInteractive: true, toolGrant: { allowedToolNames: new Set(['routine_manage']), allowConsequential: false } };

    await tool.execute({ action: 'create', title: 'Deep brief', cron_schedule: '0 8 * * 1-5', timezone: 'Europe/Warsaw', primary_model: 'reasoning' } as any, ctx);
    assert.equal(tierForRoutine(repo.getRoutine('deep_brief')!), 'ANALYSIS');

    const res: any = await tool.execute({ action: 'update_model', routine_id: 'deep_brief', primary_model: 'flash', timezone: 'Europe/Warsaw' } as any, ctx);
    assert.match(res.confirm, /Flash/);
    assert.equal(tierForRoutine(repo.getRoutine('deep_brief')!), 'ROUTINE');
  });
});
