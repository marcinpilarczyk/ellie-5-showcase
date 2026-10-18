import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase } from '../storage/schema.js';
import { ResultStore } from '../storage/result-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelCallResponse } from '../models/model-router.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { createOwnerTextCheckTool } from '../tools/owner-text-check-tool.js';
import { buildRuntime } from '../runtime/build-runtime.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { routineIdFromTitle } from '../tools/routine-tools.js';

// Backlog from RUNBOOK checks 4-7 (2026-10-15), each fixed in the shared layer and tested with made-up data.

const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };
const script = (steps: Array<(contents: any[]) => ModelCallResponse>) => {
  let i = 0;
  return { generate: async (contents: any[]) => steps[Math.min(i++, steps.length - 1)](contents) } as unknown as ModelRouter;
};
const call = (name: string, args: any): ModelCallResponse => ({ text: '', functionCalls: [{ name, args }], telemetry });
const lastResults = (contents: any[]) => contents.at(-1).parts.map((p: any) => p.functionResponse?.response?.result);

// Check 4 (run_1792053182458_n7izsdp): the model checked "Subject: ...\n\nHi ..." and wrote it by handle,
// so the sent body began with the subject again.
describe('a mail body never repeats the headers the write carries as fields (class)', () => {
  const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org';
  const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';
  let sent: any[];
  let dispatcher: ToolDispatcher;
  const grant = { allowedToolNames: new Set(['owner_text_check', 'made_up_sources', 'made_up_mail_send']), allowConsequential: true };

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    const store = new ResultStore(db);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(undefined, store, guard);
    sent = [];
    dispatcher.registerTool(createOwnerTextCheckTool(guard));
    dispatcher.registerTool({
      name: 'made_up_sources', description: 's', schema: z.object({}), effectClass: 'READ',
      providesOwnerSources: () => true, execute: async () => ({ profile: PROFILE })
    });
    dispatcher.registerTool({
      name: 'made_up_mail_send', description: 'Sends mail', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
      ownerText: { kind: 'message', text: (p: any) => `${p.subject}\n\n${p.body}`, field: 'body' },
      execute: async (p: any) => { sent.push(p); return { ok: true }; }
    });
  });

  const send = (draft: string, subject: string) => new UnifiedAgentRunner(script([
    () => ({ text: '', functionCalls: [{ name: 'made_up_sources', args: {} }, { name: 'owner_text_check', args: { kind: 'message', text: draft } }], telemetry }),
    (contents) => call('made_up_mail_send', { to: 'team@example.test', subject, body: lastResults(contents)[1].draftHandle }),
    () => call('finish', { status: 'DONE', message: 'Sent.' })
  ]), dispatcher).run({ runId: 'run_mail', trigger: 'slack_dm', instruction: 'send it', toolGrant: grant });

  it('drops a leading Subject line from a body written by draft handle', async () => {
    await send('Subject: Testing the approval path\n\nHi team,\nThe approval path is being tested.\nJan', 'Testing the approval path');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body, 'Hi team,\nThe approval path is being tested.\nJan');
    assert.equal(sent[0].subject, 'Testing the approval path');
  });

  it('drops the subject repeated as a bare first line, and leaves a body without headers as written', async () => {
    await send('Testing the approval path\nHi team,\nAll good.\nJan', 'Testing the approval path');
    assert.equal(sent[0].body, 'Hi team,\nAll good.\nJan');
    sent.length = 0;
    await send('Hi team,\nTo: the point, all good.\nJan', 'Status');
    assert.equal(sent[0].body, 'Hi team,\nTo: the point, all good.\nJan');
  });
});

// Check 5 (run_1792053323392_5cmx22w): create failed without routine_id, then replied with a reaction
// only, so the owner never saw the schedule Ellie understood. Check 7: the reply that reached Slack was
// not in the trace.
describe('routine create from Slack: id from the title, confirmed in words, reply in the trace', { concurrency: 1 }, () => {
  it('makes a readable id from any title', () => {
    assert.equal(routineIdFromTitle('Morning brief'), 'morning_brief');
    assert.equal(routineIdFromTitle('  Przegląd poczty — 9:00! '), 'przeglad_poczty_9_00');
    assert.equal(routineIdFromTitle('!!!'), '');
  });

  it('a reaction-only finish after a create becomes a text confirmation, recorded as delivered', async () => {
    const owner = process.env.SLACK_OWNER_USER_ID || 'U_OWNER_TEST';
    process.env.SLACK_OWNER_USER_ID = owner;
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    const model = script([
      () => call('routine_manage', { action: 'create', title: 'Made-up digest', cron_schedule: '30 7 * * 1-5', description: 'List new made-up items.' }),
      () => call('finish', { status: 'DONE', deliveryMode: 'REACTION_ONLY', reactionEmoji: 'white_check_mark', message: '' })
    ]);
    const traces = runtime.runTraceStore;
    const runner = new UnifiedAgentRunner(model, runtime.dispatcher, undefined, traces);
    const posted: string[] = [];
    const reactions: string[] = [];
    const slack: any = {
      isConfigured: () => true, defaultChannel: 'C1',
      addReaction: async (r: any) => { reactions.push(r.name); return {}; }, removeReaction: async () => ({}),
      postMessage: async (m: any) => { posted.push(m.text); return { ok: true, ts: '1.1' }; },
      updateMessage: async (m: any) => { posted.push(m.text); return { ok: true }; },
      getConversationReplies: async () => []
    };
    const service = new SlackCoworkerService(slack, runtime.ledgerRepo, runner, 'http://x', undefined, undefined, traces);
    await service.handleUserMessage({ type: 'message', user: owner, channel: 'D1', channel_type: 'im', text: 'every weekday at 7:30 list new made-up items', ts: '200.1' } as any);

    const routine = runtime.routineRepo.getRoutine('made_up_digest');
    assert.ok(routine, 'created under an id made from the title');
    assert.equal(routine!.cron_schedule, '30 7 * * 1-5');
    const confirmation = 'Created routine "Made-up digest" (made_up_digest): Mon-Fri 07:30, Europe/Warsaw, active.';
    assert.ok(posted.includes(confirmation), JSON.stringify(posted));
    assert.ok(!reactions.includes('white_check_mark'), 'no reaction in place of the answer');
    const [trace] = traces.listTraces(1);
    assert.equal(trace.delivery_mode, 'SLACK_MESSAGE');
    assert.equal(trace.delivered_text, confirmation);
  });

  it('a routine post is recorded in its run trace', async () => {
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    const traces = runtime.runTraceStore;
    const slack: any = { isConfigured: () => true, defaultChannel: 'C1', postMessage: async () => ({ ok: true, ts: '3.1', channel: 'C1' }) };
    const service = new SlackCoworkerService(slack, runtime.ledgerRepo, {} as any, 'http://x', undefined, undefined, traces);
    const run = await new UnifiedAgentRunner(script([() => call('finish', { status: 'DONE', message: 'Two made-up items.' })]), runtime.dispatcher, undefined, traces)
      .run({ runId: 'run_routine_post', trigger: 'routine', instruction: 'made-up routine', toolGrant: { allowedToolNames: new Set(), allowConsequential: false } });
    await service.postProactive('*Made-up digest*\nTwo made-up items.', run.runId);
    assert.equal(traces.getTrace('run_routine_post')!.delivered_text, '*Made-up digest*\nTwo made-up items.');
  });
});
