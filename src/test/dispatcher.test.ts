import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { ToolDefinition, ToolExecutionContext } from '../types/tool.js';

describe('ToolDispatcher & Governance', () => {
  let appDb: DatabaseSync;
  let ledgerDb: DatabaseSync;
  let ledgerRepo: ActionLedgerRepository;
  let resultStore: ResultStore;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    appDb = new DatabaseSync(':memory:');
    ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);

    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    resultStore = new ResultStore(appDb);
    dispatcher = new ToolDispatcher(ledgerRepo, resultStore);
  });

  it('immediately executes safe READ tools and returns output', async () => {
    const readTool: ToolDefinition = {
      name: 'gmail_read_thread',
      description: 'Read thread',
      schema: z.object({ threadId: z.string() }),
      effectClass: 'READ',
      execute: async () => ({ messages: ['Hello world email'] })
    };
    dispatcher.registerTool(readTool);

    const context: ToolExecutionContext = {
      runId: 'run_read',
      isInteractive: true,
      toolGrant: {
        allowedToolNames: new Set(['gmail_read_thread']),
        allowConsequential: false
      }
    };

    const result = await dispatcher.dispatch('gmail_read_thread', { threadId: 't123' }, context);
    assert.deepEqual(result, { messages: ['Hello world email'] });
  });

  it('intercepts tool outputs above RESULT_STORE_THRESHOLD and saves into Result Store', async () => {
    const bigContent = 'x'.repeat(7000);
    const readTool: ToolDefinition = {
      name: 'drive_read_file',
      description: 'Read file',
      schema: z.object({ fileId: z.string() }),
      effectClass: 'READ',
      execute: async () => bigContent
    };
    dispatcher.registerTool(readTool);

    const context: ToolExecutionContext = {
      runId: 'run_big',
      isInteractive: true,
      toolGrant: {
        allowedToolNames: new Set(['drive_read_file']),
        allowConsequential: false
      }
    };

    const result = await dispatcher.dispatch('drive_read_file', { fileId: 'doc123' }, context);
    assert.equal(result.isStored, true);
    assert.ok(result.handle);
    assert.ok(result.preview);
    assert.equal(result.totalChars, 7000);

    const stored = resultStore.get(result.handle);
    assert.ok(stored !== null);
    assert.equal(stored.content, bigContent);
  });

  describe('per-run read memo', () => {
    let fetches: number;
    const runContext = (runId: string): ToolExecutionContext => ({
      runId,
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['made_up_fetch', 'made_up_write']), allowConsequential: false },
      readMemo: new Map()
    });

    beforeEach(() => {
      fetches = 0;
      dispatcher.registerTool({
        name: 'made_up_fetch',
        description: 'Fetch something from a provider',
        schema: z.object({ id: z.string(), opts: z.object({ a: z.number(), b: z.number() }).optional() }),
        effectClass: 'READ',
        execute: async (p: any) => { fetches++; return { id: p.id, body: 'y'.repeat(7000) }; }
      });
      dispatcher.registerTool({
        name: 'made_up_write',
        description: 'Change something',
        schema: z.object({}),
        effectClass: 'INTERNAL_REVERSIBLE_WRITE',
        readsBackInline: true,
        execute: async () => ({ ok: true })
      });
    });

    it('serves an identical read from the memo, whatever the key order', async () => {
      const ctx = runContext('run_memo');
      const first = await dispatcher.dispatch('made_up_fetch', { id: 'p1', opts: { a: 1, b: 2 } }, ctx);
      const second = await dispatcher.dispatch('made_up_fetch', { opts: { b: 2, a: 1 }, id: 'p1' }, ctx);

      assert.equal(fetches, 1, 'the provider is called once');
      assert.equal(first.isStored, true);
      assert.equal(second.handle, first.handle, 'same stored result, no second handle');
      assert.ok(second.repeatedCall);

      await dispatcher.dispatch('made_up_fetch', { id: 'p2' }, ctx);
      assert.equal(fetches, 2, 'different params are a new read');

      await dispatcher.dispatch('made_up_fetch', { id: 'p1', opts: { a: 1, b: 2 } }, runContext('run_other'));
      assert.equal(fetches, 3, 'another run has its own memo');
    });

    it('forgets earlier reads after any write in the run', async () => {
      const ctx = runContext('run_write');
      await dispatcher.dispatch('made_up_fetch', { id: 'p1' }, ctx);
      await dispatcher.dispatch('made_up_write', {}, ctx);
      const again = await dispatcher.dispatch('made_up_fetch', { id: 'p1' }, ctx);
      assert.equal(fetches, 2);
      assert.equal(again.repeatedCall, undefined);
    });
  });

  it('stages CONSEQUENTIAL actions in ledger instead of direct execution', async () => {
    let executed = false;
    const sendTool: ToolDefinition = {
      name: 'gmail_send',
      description: 'Send email',
      schema: z.object({ to: z.string(), body: z.string() }),
      effectClass: 'CONSEQUENTIAL',
      execute: async () => {
        executed = true;
        return { sent: true };
      }
    };
    dispatcher.registerTool(sendTool);

    const context: ToolExecutionContext = {
      runId: 'run_send',
      isInteractive: true,
      toolGrant: {
        allowedToolNames: new Set(['gmail_send']),
        allowConsequential: true
      },
      slackOrigin: {
        channel: 'C12345',
        threadTs: '222.333'
      }
    };

    const result = await dispatcher.dispatch(
      'gmail_send',
      { to: 'founder@example.com', body: 'Let us connect' },
      context
    );

    assert.equal(result.status, 'STAGED_FOR_APPROVAL');
    assert.equal(executed, false, 'Send tool must NOT execute directly before owner approval');
    assert.ok(result.actionId);

    const staged = ledgerRepo.get(result.actionId);
    assert.ok(staged !== null);
    assert.equal(staged.action_type, 'gmail_send');
    assert.equal(staged.state, 'STAGED');
    assert.equal(staged.slack_thread_ts, '222.333');
  });

  it('fails closed when tool is not on execution grant whitelist', async () => {
    const ungrantedTool: ToolDefinition = {
      name: 'dangerous_action',
      description: 'Not granted',
      schema: z.object({}),
      effectClass: 'READ',
      execute: async () => ({ ok: true })
    };
    dispatcher.registerTool(ungrantedTool);

    const context: ToolExecutionContext = {
      runId: 'run_blocked',
      isInteractive: true,
      toolGrant: {
        allowedToolNames: new Set([]), // Empty grant
        allowConsequential: false
      }
    };

    await assert.rejects(
      async () => dispatcher.dispatch('dangerous_action', {}, context),
      /Security Refusal/
    );
  });
});
