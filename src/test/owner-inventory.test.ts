import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { OwnerInventory } from '../storage/owner-inventory.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelCallResponse } from '../models/model-router.js';

const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };

describe('Owner Doc inventory (nightly map, made-up Docs)', () => {
  let db: DatabaseSync;
  let inventory: OwnerInventory;
  let described: string[];
  const describe_ = async (title: string) => { described.push(title); return `What ${title} is for.`; };

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    inventory = new OwnerInventory(db);
    described = [];
  });

  it('describes new and changed Docs only, keeps unchanged ones, drops removed ones', async () => {
    const day1 = [
      { id: 'a', title: 'Alpha Notes', path: '', text: 'alpha v1' },
      { id: 'b', title: 'Beta Rules', path: '/Projects/X', text: 'beta' },
      { id: 'c', title: 'Gamma', path: '', text: 'gamma' }
    ];
    const r1 = await inventory.refresh(day1, describe_, new Date('2026-10-15T02:00:00Z'));
    assert.deepEqual(r1, { total: 3, described: 3, unchanged: 0, removed: 0, failed: 0 });

    const day2 = [
      { id: 'a', title: 'Alpha Notes', path: '', text: 'alpha v2' },
      { id: 'b', title: 'Beta Rules', path: '/Projects/X', text: 'beta' }
    ];
    described = [];
    const r2 = await inventory.refresh(day2, describe_, new Date('2026-10-16T02:00:00Z'));
    assert.deepEqual(r2, { total: 2, described: 1, unchanged: 1, removed: 1, failed: 0 });
    assert.deepEqual(described, ['Alpha Notes']);
    assert.deepEqual(inventory.list().map(r => r.doc_id), ['a', 'b']);
  });

  it('keeps the old description (or the first line) when describing fails', async () => {
    await inventory.refresh([{ id: 'a', title: 'Alpha', path: '', text: 'First line\nmore' }], async () => { throw new Error('model down'); });
    assert.equal(inventory.list()[0].purpose, 'First line');
  });

  it('is due when never run, then once per local day after 03:00 (Europe/Warsaw)', async () => {
    assert.equal(inventory.isDue(new Date('2026-10-15T10:00:00Z')), true);
    await inventory.refresh([], describe_, new Date('2026-10-15T10:00:00Z'));
    assert.equal(inventory.isDue(new Date('2026-10-15T22:30:00Z')), false, 'same local day');
    assert.equal(inventory.isDue(new Date('2026-10-16T00:30:00Z')), false, 'next day, 02:30 local');
    assert.equal(inventory.isDue(new Date('2026-10-16T01:30:00Z')), true, 'next day, 03:30 local');
  });

  it('reaches the model as a prompt block, sorted and stable, so the run can read Docs in its first step', async () => {
    await inventory.refresh([
      { id: 'b', title: 'Beta Rules', path: '/Projects/X', text: 'beta' },
      { id: 'a', title: 'Alpha Notes', path: '', text: 'alpha' }
    ], describe_, new Date('2026-10-15T10:00:00Z'));

    let systemInstruction = '';
    const mockRouter = {
      generate: async (_c: any, cfg: any): Promise<ModelCallResponse> => {
        systemInstruction = cfg.systemInstruction;
        return { text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'ok' } }], telemetry };
      }
    } as unknown as ModelRouter;
    const ledgerDb = new DatabaseSync(':memory:');
    initializeLedgerDatabase(ledgerDb);
    const dispatcher = new ToolDispatcher(new ActionLedgerRepository(ledgerDb), new ResultStore(db));
    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, new RunTraceStore(db), inventory);
    await runner.run({ runId: 'inv_run', trigger: 'slack_dm', instruction: 'hi', toolGrant: { allowedToolNames: new Set(), allowConsequential: false } });

    assert.match(systemInstruction, /WORKING DOCS \(inventory refreshed 2026-10-15/);
    const a = systemInstruction.indexOf('- Alpha Notes (/, 5 chars): What Alpha Notes is for.');
    const b = systemInstruction.indexOf('- Beta Rules (/Projects/X, 4 chars): What Beta Rules is for.');
    assert.ok(a > 0 && b > a, 'both Docs listed, root first');
  });

  it('adds nothing to the prompt before the first refresh', () => {
    assert.equal(inventory.promptBlock(), '');
  });
});
