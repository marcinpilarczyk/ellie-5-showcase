import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { executeApprovedAction } from '../governance/executor.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { ToolDefinition, ToolExecutionContext } from '../types/tool.js';

describe('Approval flow (stage → approve → execute)', () => {
  let ledgerRepo: ActionLedgerRepository;
  let dispatcher: ToolDispatcher;
  let sent: any[];
  let guardBlocks: boolean;
  const savedEnv = { ...process.env };

  const interactive: ToolExecutionContext = {
    runId: 'run_slack_1',
    isInteractive: true,
    toolGrant: { allowedToolNames: new Set(['gmail_send']), allowConsequential: true },
    slackOrigin: { channel: 'C1', threadTs: '1.0', isDirectMessage: true }
  };

  beforeEach(() => {
    const ledgerDb = new DatabaseSync(':memory:');
    initializeLedgerDatabase(ledgerDb);
    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    dispatcher = new ToolDispatcher(ledgerRepo);
    sent = [];
    guardBlocks = false;
    delete process.env.ELLIE_SEND_ALLOWLIST;
    delete process.env.ELLIE_MAX_DAILY_SENDS;

    const sendTool: ToolDefinition = {
      name: 'gmail_send',
      description: 'send',
      effectClass: 'CONSEQUENTIAL',
      schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      execute: async (params) => {
        // Stands in for the Claims Bank guard inside the real tool
        if (guardBlocks) throw new Error('[Claims Bank Refusal] unsupported claim');
        sent.push(params);
        return { messageId: `m${sent.length}` };
      }
    };
    dispatcher.registerTool(sendTool);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  const stage = async (to = 'anna@example.com', subject = 'Hi') =>
    (await dispatcher.dispatch('gmail_send', { to, subject, body: 'Hello' }, interactive)) as any;

  it('stages instead of sending, then approval runs the tool itself', async () => {
    const staged = await stage();
    assert.equal(staged.status, 'STAGED_FOR_APPROVAL');
    assert.equal(sent.length, 0);

    const outcome = await executeApprovedAction(staged.actionId, { ledgerRepo, dispatcher });
    assert.equal(outcome.ok, true);
    // No read-back hook on this tool, so it is provider-confirmed, not verified (P7)
    assert.equal(outcome.status, 'PROVIDER_CONFIRMED');
    assert.equal(sent.length, 1);
    assert.equal(ledgerRepo.get(staged.actionId)!.state, 'PROVIDER_CONFIRMED');
  });

  it('tool-level guards (Claims Bank) still apply on approval', async () => {
    const staged = await stage();
    guardBlocks = true;
    const outcome = await executeApprovedAction(staged.actionId, { ledgerRepo, dispatcher });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.status, 'FAILED_SAFE');
    assert.equal(sent.length, 0);
  });

  it('enforces ELLIE_SEND_ALLOWLIST and leaves the action editable', async () => {
    process.env.ELLIE_SEND_ALLOWLIST = 'me@example.com,@trusted.org';
    const blocked = await stage('stranger@evil.com');
    const outcome = await executeApprovedAction(blocked.actionId, { ledgerRepo, dispatcher });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /ALLOWLIST/);
    assert.equal(ledgerRepo.get(blocked.actionId)!.state, 'STAGED');

    const allowed = await stage('Bob <bob@trusted.org>');
    assert.equal((await executeApprovedAction(allowed.actionId, { ledgerRepo, dispatcher })).ok, true);
  });

  it('enforces ELLIE_MAX_DAILY_SENDS', async () => {
    process.env.ELLIE_MAX_DAILY_SENDS = '1';
    const first = await stage();
    assert.equal((await executeApprovedAction(first.actionId, { ledgerRepo, dispatcher })).ok, true);
    const second = await stage('anna@example.com', 'Second subject');
    const outcome = await executeApprovedAction(second.actionId, { ledgerRepo, dispatcher });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Daily send cap/);
    assert.equal(sent.length, 1);
  });

  it('Slack Approve button executes the action and settles the card', async () => {
    const staged = await stage();
    const updates: any[] = [];
    const slack: any = {
      updateMessage: async (m: any) => { updates.push(m); return {}; },
      postMessage: async () => ({})
    };
    const service = new SlackCoworkerService(slack, ledgerRepo, {} as any, undefined,
      (id, actor) => executeApprovedAction(id, { ledgerRepo, dispatcher, actor }));

    await service.handleButtonInteraction({
      actions: [{ action_id: 'approve_action', value: staged.actionId }],
      channel: { id: 'C1' },
      message: { ts: '2.0' },
      user: { id: 'UOWNER' }
    });

    assert.equal(sent.length, 1);
    assert.equal(ledgerRepo.get(staged.actionId)!.state, 'PROVIDER_CONFIRMED');
    assert.match(JSON.stringify(updates[0].blocks), /provider confirmed/);
  });

  it('background routines may stage into their batch but never execute', async () => {
    const bg: ToolExecutionContext = {
      runId: 'run_bg',
      isInteractive: false,
      batchId: 'batch_x',
      toolGrant: { allowedToolNames: new Set(['gmail_send']), allowConsequential: false }
    };
    const staged: any = await dispatcher.dispatch('gmail_send', { to: 'a@b.c', subject: 's', body: 'b' }, bg);
    assert.equal(staged.status, 'STAGED_FOR_APPROVAL');
    assert.equal(staged.batchId, 'batch_x');
    assert.equal(sent.length, 0);

    await assert.rejects(
      dispatcher.dispatch('gmail_send', { to: 'a@b.c', subject: 's', body: 'b' }, { ...bg, batchId: undefined }),
      /Security Refusal/
    );
  });
});



describe('Runner tool execution', () => {
  it('runs independent READ calls in parallel and keeps response order', async () => {
    const { UnifiedAgentRunner } = await import('../agent/runner.js');
    const dispatcher = new ToolDispatcher();
    const slowRead = (name: string): ToolDefinition => ({
      name, description: name, effectClass: 'READ', schema: z.object({}),
      execute: async () => { await new Promise(r => setTimeout(r, 150)); return name; }
    });
    dispatcher.registerTool(slowRead('read_a'));
    dispatcher.registerTool(slowRead('read_b'));

    let call = 0;
    const router: any = {
      modelName: 'test',
      generate: async () => {
        call++;
        const telemetry = { promptTokens: 0, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 0, totalTokens: 0, durationMs: 0, model: 'test' };
        return call === 1
          ? { text: '', functionCalls: [{ name: 'read_a', args: {} }, { name: 'read_b', args: {} }], telemetry, rawResponse: {} }
          : { text: JSON.stringify({ deliveryMode: 'SLACK_MESSAGE', coworkerHeadline: 'done', summary: 'done' }), telemetry, rawResponse: {} };
      }
    };

    const start = Date.now();
    const res = await new UnifiedAgentRunner(router, dispatcher).run({
      trigger: 'manual',
      instruction: 'read both',
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set(['read_a', 'read_b']), allowConsequential: false }
    });
    assert.ok(Date.now() - start < 380, 'two 150ms reads should overlap');
    assert.deepEqual(res.toolCallsExecuted.map(c => c.result), ['read_a', 'read_b']);
  });
});
