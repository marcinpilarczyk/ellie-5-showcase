import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { RoutineRepository } from '../storage/routine-repo.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { RoutineWorker } from '../scheduler/routine-worker.js';
import { SlackCoworkerService, SlackStatusReporter } from '../integrations/slack/coworker.js';
import { ToolDefinition } from '../types/tool.js';

const DOC_ID = 'DOC_abcdefghijklmnopqrstuvwxyz123';
const DOC_URL = `https://docs.google.com/document/d/${DOC_ID}/edit`;
const telemetry = { promptTokens: 0, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 0, totalTokens: 0, durationMs: 0, model: 'test' };

/** Fake Gemini: plays back a script of function calls and records every request. */
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

function testDispatcher(): ToolDispatcher {
  const dispatcher = new ToolDispatcher();
  const webSearch: ToolDefinition = {
    name: 'web_search', description: 'search', effectClass: 'READ', schema: z.object({ query: z.string() }),
    execute: async ({ query }) => ({ results: [`result for ${query}`] })
  };
  const docsCreate: ToolDefinition = {
    name: 'docs_create', description: 'create doc', effectClass: 'INTERNAL_REVERSIBLE_WRITE', readsBackInline: true,
    schema: z.object({ title: z.string(), content: z.string() }),
    execute: async () => ({ documentId: DOC_ID, url: DOC_URL })
  };
  dispatcher.registerTool(webSearch);
  dispatcher.registerTool(docsCreate);
  return dispatcher;
}

function fakeSlackService() {
  const posts: string[] = [];
  const carryovers: string[] = [];
  return {
    posts,
    carryovers,
    service: {
      postProactive: async (text: string) => { posts.push(text); return { ok: true, ts: '900.1', channel: 'C1' }; },
      saveCarryover: (channel: string, ts: string) => { carryovers.push(`${channel}:${ts}`); },
      notifyBatchStaged: async () => {}
    } as any
  };
}

describe('Routines deliver what they produce', () => {
  let routineRepo: RoutineRepository;
  let ledgerRepo: ActionLedgerRepository;

  beforeEach(() => {
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    routineRepo = new RoutineRepository(appDb);
    ledgerRepo = new ActionLedgerRepository(ledgerDb);
  });

  const addRoutine = (overrides: Partial<Parameters<RoutineRepository['upsertRoutine']>[0]> = {}) => {
    routineRepo.upsertRoutine({
      id: 'indie_lab',
      title: 'Indie Lab Topic Research',
      description: 'Researches angles for The Indie Lab.',
      cron_schedule: '51 10 * * 1,4',
      destination: 'Docs: The Indie Lab Results folder',
      default_grant: ['web_search', 'docs_create', 'delegate_subtask'],
      hard_constraints: ['Create the dated pack with google_docs_create in Results folder 1vOM and report its link.'],
      rules: ['Numbers first.'],
      primary_model: 'gemini-pro',
      ...overrides
    });
  };

  it('runs the full task and posts the result with the doc link to Slack', async () => {
    addRoutine();
    const model = scriptedModel([
      [{ name: 'web_search', args: { query: 'indie publishing data' } }],
      [{ name: 'docs_create', args: { title: 'Pack', content: 'angles' } }],
      [{ name: 'finish', args: { status: 'DONE', message: 'Created this week\'s pack with 6 angles; the strongest is the KDP pricing experiment.', artifactLink: DOC_URL } }]
    ]);
    const slack = fakeSlackService();
    const worker = new RoutineWorker(routineRepo, new UnifiedAgentRunner(model.router, testDispatcher()), ledgerRepo, slack.service);

    const res = await worker.runRoutineNow('indie_lab');

    // The model saw the real task, not just the one-line description
    const firstPrompt = JSON.stringify(model.requests[0].contents);
    assert.match(firstPrompt, /Results folder 1vOM/);
    assert.match(firstPrompt, /Numbers first/);
    assert.match(firstPrompt, /\[Now: [A-Z][a-z]+day, /, 'every run is told the local date and time');
    assert.match(firstPrompt, /delegate_subtask/, 'unavailable tools are named to the model');
    // granted tools are declared; unknown ones are reported instead
    const declared = model.requests[0].config.tools[0].functionDeclarations.map((d: any) => d.name);
    assert.ok(declared.includes('web_search'));
    assert.ok(declared.includes('docs_create'));
    assert.ok(!declared.includes('delegate_subtask'), 'unknown tools are not declared');
    // primaryModel gemini-pro runs on the Argon tier
    assert.equal(model.requests[0].config.tier, 'ANALYSIS');

    assert.equal(slack.posts.length, 1);
    assert.match(slack.posts[0], /Indie Lab Topic Research/);
    assert.match(slack.posts[0], /KDP pricing experiment/);
    assert.ok(slack.posts[0].includes(DOC_URL));
    assert.deepEqual(slack.carryovers, ['C1:900.1'], 'replies to the post keep the evidence');
    assert.equal(res.delivery, 'DELIVERED');
    assert.equal(routineRepo.getRoutine('indie_lab')!.last_run_status, 'DELIVERED');
  });

  it('stays silent only when the routine allows it', async () => {
    const quietScript = [[{ name: 'finish', args: { status: 'NOTHING_TO_REPORT', message: 'No changes.' } }]];

    addRoutine({ id: 'quiet', allow_silence: true });
    let slack = fakeSlackService();
    let worker = new RoutineWorker(routineRepo, new UnifiedAgentRunner(scriptedModel(quietScript).router, testDispatcher()), ledgerRepo, slack.service);
    assert.equal((await worker.runRoutineNow('quiet')).delivery, 'SILENT');
    assert.equal(slack.posts.length, 0);

    addRoutine({ id: 'loud', allow_silence: false });
    slack = fakeSlackService();
    worker = new RoutineWorker(routineRepo, new UnifiedAgentRunner(scriptedModel(quietScript).router, testDispatcher()), ledgerRepo, slack.service);
    assert.equal((await worker.runRoutineNow('loud')).delivery, 'DELIVERED');
    assert.match(slack.posts[0], /No changes/);
  });

  it('reports a failed run in Slack instead of marking it completed', async () => {
    addRoutine();
    const model = scriptedModel([new Error('Gemini 503')]);
    const slack = fakeSlackService();
    const worker = new RoutineWorker(routineRepo, new UnifiedAgentRunner(model.router, testDispatcher()), ledgerRepo, slack.service);

    const res = await worker.runRoutineNow('indie_lab');
    assert.equal(res.delivery, 'FAILED');
    assert.match(slack.posts[0], /⚠️/);
    assert.match(slack.posts[0], /Gemini 503/);
  });

  it('runs a routine once at a time however often it is started, across workers', async () => {
    addRoutine({ id: 'made_up', title: 'Made-up digest', cron_schedule: '* * * * *', allow_silence: false });
    routineRepo.updateLastRun('made_up', '2000-01-01T00:00:00.000Z');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let modelCalls = 0;
    const router = {
      modelName: 'test',
      generate: async () => {
        modelCalls++;
        await gate;
        return { text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Digest ready.' } }], telemetry, rawResponse: {} };
      }
    } as any;
    const slack = fakeSlackService();
    let delivered!: () => void;
    const posted = new Promise<void>(r => { delivered = r; });
    const postProactive = slack.service.postProactive;
    slack.service.postProactive = async (text: string) => { const res = await postProactive(text); delivered(); return res; };
    const server = new RoutineWorker(routineRepo, new UnifiedAgentRunner(router, testDispatcher()), ledgerRepo, slack.service);
    const wake = new RoutineWorker(routineRepo, new UnifiedAgentRunner(router, testDispatcher()), ledgerRepo, slack.service);

    // The owner clicks Run now eight times while the first run is still going
    const starts = Array.from({ length: 8 }, () => server.startRoutineNow('made_up'));
    assert.equal(starts[0].started, true);
    for (const s of starts.slice(1)) {
      assert.equal(s.started, false);
      assert.equal(s.alreadyRunning, true);
      assert.match(s.error!, /already running/);
    }
    assert.ok(routineRepo.getRoutine('made_up')!.running_since, 'the control page can show the run in progress');
    // The wake cycle (another process, same database) skips it too
    assert.equal((await wake.runDueRoutines(new Date(), 1)).routinesRun, 0);
    await assert.rejects(server.runRoutineNow('made_up'), /already running/);

    release();
    await posted;
    await new Promise(r => setImmediate(r));
    assert.equal(slack.posts.length, 1, 'one Slack post, not eight');
    assert.equal(modelCalls, 1);
    assert.equal(routineRepo.getRoutine('made_up')!.running_since, null, 'the claim is released when the run ends');
    assert.equal(routineRepo.getRoutine('made_up')!.last_run_status, 'DELIVERED');

    // A claim left by a crashed run is taken over once it is stale
    routineRepo.claimRun('made_up', '2000-01-01T00:00:00.000Z', '1999-01-01T00:00:00.000Z');
    assert.equal(server.startRoutineNow('made_up').started, true);
  });
});

describe('Interactive runs end only through finish', () => {
  const grant = { allowedToolNames: new Set(['web_search', 'docs_create']), allowConsequential: false };

  it('keeps working after tool calls and ends with the finish message', async () => {
    const model = scriptedModel([
      [{ name: 'web_search', args: { query: 'Ocean Technologies Group' } }],
      [{ name: 'docs_create', args: { title: 'Resume', content: '...' } }],
      [{ name: 'finish', args: { status: 'DONE', message: 'Tailored resume is ready.', artifactLink: DOC_URL } }]
    ]);
    const res = await new UnifiedAgentRunner(model.router, testDispatcher()).run({
      trigger: 'slack_dm', instruction: 'lets create a tailored resume', isInteractive: true, toolGrant: grant
    });

    assert.equal(model.requests.length, 3);
    assert.equal(model.requests[0].config.toolConfig.functionCallingConfig.mode, 'ANY', 'every turn must be a tool call');
    assert.equal(res.output.finishStatus, 'DONE');
    assert.equal(res.output.slackMessage, 'Tailored resume is ready.');
    assert.equal(res.output.artifactLink, DOC_URL);
  });

  it('rejects finish sent together with other calls and keeps going', async () => {
    const model = scriptedModel([
      [{ name: 'web_search', args: { query: 'x' } }, { name: 'finish', args: { status: 'DONE', message: 'Working on it now.' } }],
      [{ name: 'finish', args: { status: 'DONE', message: 'Here is the answer.' } }]
    ]);
    const res = await new UnifiedAgentRunner(model.router, testDispatcher()).run({
      trigger: 'slack_dm', instruction: 'research x', isInteractive: true, toolGrant: grant
    });
    assert.equal(res.output.slackMessage, 'Here is the answer.');
    assert.match(JSON.stringify(model.requests[1].contents), /finish must be called alone/);
  });

  it('forces a finish-only last round when the budget runs out', async () => {
    const model = scriptedModel([
      [{ name: 'web_search', args: { query: 'a' } }],
      [{ name: 'finish', args: { status: 'BLOCKED', message: 'Read the job post; the doc is not written yet. Reply "continue".' } }]
    ]);
    const res = await new UnifiedAgentRunner(model.router, testDispatcher()).run({
      trigger: 'slack_dm', instruction: 'big task', isInteractive: true, toolGrant: grant, maxRounds: 2
    });
    assert.deepEqual(model.requests[1].config.toolConfig.functionCallingConfig.allowedFunctionNames, ['finish']);
    assert.match(JSON.stringify(model.requests[1].contents), /last step/);
    assert.equal(res.output.finishStatus, 'BLOCKED');
  });

  it('drops an artifact link that no tool returned', async () => {
    const model = scriptedModel([
      [{ name: 'finish', args: { status: 'DONE', message: 'Done.', artifactLink: 'https://docs.google.com/document/d/INVENTED_ID_0000000000000000/edit' } }]
    ]);
    const res = await new UnifiedAgentRunner(model.router, testDispatcher()).run({
      trigger: 'slack_dm', instruction: 'make a doc', isInteractive: true, toolGrant: grant
    });
    assert.equal(res.output.artifactLink, undefined);
  });
});

describe('Slack follow-through', () => {
  it('posts a live status after a delay and replaces it with the answer', async () => {
    const posted: any[] = [];
    const updated: any[] = [];
    const slack: any = {
      postMessage: async (m: any) => { posted.push(m); return { ok: true, ts: 'status.1' }; },
      updateMessage: async (m: any) => { updated.push(m); return { ok: true }; }
    };
    const status = new SlackStatusReporter(slack, 'C1', '100.1', 10);
    status.step('docs_read');
    await new Promise(r => setTimeout(r, 40));
    assert.equal(posted.length, 1);
    assert.match(posted[0].text, /Reading a Google Doc/);
    assert.equal(posted[0].thread_ts, '100.1');

    assert.equal(await status.finish('Here is your resume.'), true);
    assert.equal(updated[updated.length - 1].text, 'Here is your resume.');
    assert.equal(updated[updated.length - 1].ts, 'status.1');
  });

  it('does not post a status message for fast replies', async () => {
    const slack: any = { postMessage: async () => { throw new Error('should not post'); }, updateMessage: async () => ({ ok: true }) };
    const status = new SlackStatusReporter(slack, 'C1', '100.1', 1000);
    status.step('web_search');
    assert.equal(await status.finish('quick answer'), false);
  });

  it('runs messages in the same thread one at a time and carries evidence forward', async () => {
    const appDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    const carryover = new ThreadCarryoverRepository(appDb);

    const order: string[] = [];
    const seenParts: any[][] = [];
    const runner: any = {
      dispatcher: { getAllTools: () => [] },
      run: async (opts: any) => {
        order.push(`start:${opts.instruction}`);
        seenParts.push(opts.userParts);
        await new Promise(r => setTimeout(r, 30));
        order.push(`end:${opts.instruction}`);
        return {
          runId: `run_${opts.instruction}`, status: 'COMPLETED',
          output: { deliveryMode: 'SLACK_MESSAGE', finishStatus: 'DONE', slackMessage: 'ok', summary: 'ok' },
          toolCallsExecuted: [{ tool: 'web_search', params: { query: 'job' }, result: { results: ['Implementation Director, Poland'] }, durationMs: 1 }],
          handlesCreated: [], telemetry
        };
      }
    };
    const slack: any = {
      addReaction: async () => ({}), removeReaction: async () => ({}),
      postMessage: async () => ({ ok: true }), updateMessage: async () => ({ ok: true }),
      getConversationReplies: async () => []
    };
    const ledger: any = { getLatestStagedByThreadTs: () => null, listStagedByRun: () => [] };
    const service = new SlackCoworkerService(slack, ledger, runner, undefined, undefined, carryover);

    const base = { type: 'message', user: 'U1', channel: 'C1', thread_ts: '100.1' };
    await Promise.all([
      service.handleUserMessage({ ...base, text: 'first', ts: '100.2' }),
      service.handleUserMessage({ ...base, text: 'second', ts: '100.3' })
    ]);

    assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
    assert.match(JSON.stringify(seenParts[1]), /Implementation Director, Poland/, 'second run sees what the first found');
    // run_1792048853034_vn796ce: a follow-up dug through old run traces for earlier material
    assert.match(JSON.stringify(seenParts[1]), /reopen any item with result_read.*never search old run traces/, 'the follow-up is told where earlier work lives');
  });
});

describe('Prefix cache (cost)', () => {
  const okResponse = { candidates: [{ content: { parts: [{ text: 'ok' }] } }], text: 'ok', usageMetadata: { promptTokenCount: 8000, cachedContentTokenCount: 7800 } };

  it('creates the prefix cache once and sends only the conversation afterwards', async () => {
    const { ModelRouter } = await import('../models/model-router.js');
    const router = new ModelRouter();
    const creates: any[] = [];
    const requests: any[] = [];
    (router as any).client = {
      caches: { create: async (req: any) => { creates.push(req); return { name: 'cachedContents/abc', usageMetadata: { totalTokenCount: 7800 } }; } },
      models: { generateContent: async (req: any) => { requests.push(req); return okResponse; } }
    };
    const config = { tier: 'INTERACTIVE' as const, systemInstruction: 'sys', tools: [{ functionDeclarations: [{ name: 'finish' }] }], toolConfig: { functionCallingConfig: { mode: 'ANY' } }, cachePrefix: true };

    await router.generate([{ role: 'user', parts: [{ text: 'a' }] }], config);
    await router.generate([{ role: 'user', parts: [{ text: 'b' }] }], config);

    assert.equal(creates.length, 1);
    assert.equal(requests[1].config.cachedContent, 'cachedContents/abc');
    assert.equal(requests[1].config.tools, undefined);
    assert.equal(requests[1].config.systemInstruction, undefined);
  });

  it('falls back to an uncached request when the cache cannot be created or used', async () => {
    const { ModelRouter } = await import('../models/model-router.js');
    const router = new ModelRouter();
    let createCalls = 0;
    const requests: any[] = [];
    (router as any).client = {
      caches: { create: async () => { createCalls++; throw new Error('below minimum token count'); } },
      models: { generateContent: async (req: any) => { requests.push(req); return okResponse; } }
    };
    const config = { tier: 'INTERACTIVE' as const, systemInstruction: 'sys', tools: [{ functionDeclarations: [{ name: 'finish' }] }], cachePrefix: true };

    await router.generate([], config);
    await router.generate([], config);
    assert.equal(createCalls, 1, 'a failed cache is not retried on every call');
    assert.equal(requests[1].config.systemInstruction, 'sys');
  });
});
