import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase } from '../storage/schema.js';
import { ResultStore, RESULT_PREVIEW_CHARS, MAX_SLICE_CHARS } from '../storage/result-store.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelCallResponse } from '../models/model-router.js';
import { createResultReadTool } from '../tools/result-tools.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { createOwnerTextCheckTool } from '../tools/owner-text-check-tool.js';

// Every model round costs ~4 s before it generates anything (2026-10-15, 179 rounds over 22 Slack
// runs). These tests pin the class fixes that remove rounds, each with made-up tools.

const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };
const script = (steps: Array<(contents: any[]) => ModelCallResponse>) => {
  let i = 0;
  return { generate: async (contents: any[]) => steps[Math.min(i++, steps.length - 1)](contents) } as unknown as ModelRouter;
};
const finish = (message = 'Done.'): ModelCallResponse => ({ text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message } }], telemetry });
const lastResults = (contents: any[]) => contents.at(-1).parts.map((p: any) => p.functionResponse?.response?.result);

describe('Fewer rounds (class)', () => {
  let db: DatabaseSync;
  let store: ResultStore;
  let dispatcher: ToolDispatcher;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    store = new ResultStore(db);
    dispatcher = new ToolDispatcher(undefined, store);
    dispatcher.registerTool(createResultReadTool(store));
  });

  // Trace run_1792050852406_5jr6jy3: a follow-up reopened a 5k-char posting by handle with
  // limit 50 and limit 100 (meant as lines, read as characters), got 146 and 199 chars, and needed
  // a third call for the text. A read with only a handle now returns the whole result.
  it('a follow-up reopens a stored result in one result_read, whatever paging arguments the model guesses', async () => {
    const page = Array.from({ length: 200 }, (_, i) => `Line ${i} of the made-up posting.`).join('\n') + '\nLAST LINE: apply by Friday';
    assert.ok(page.length > RESULT_PREVIEW_CHARS && page.length < MAX_SLICE_CHARS);
    dispatcher.registerTool({
      name: 'made_up_page_read', description: 'Reads a page', effectClass: 'READ',
      schema: z.object({ url: z.string() }),
      execute: async (p: any) => ({ url: p.url, text: page })
    });
    const grant = { allowedToolNames: new Set(['result_read', 'made_up_page_read']), allowConsequential: false };
    const carryover = new ThreadCarryoverRepository(db, store);

    const run1 = await new UnifiedAgentRunner(script([
      () => ({ text: '', functionCalls: [{ name: 'made_up_page_read', args: { url: 'https://example.test/job' } }], telemetry }),
      () => finish('Worth applying.')
    ]), dispatcher).run({ runId: 'run_1', trigger: 'slack_dm', instruction: 'should I apply?', toolGrant: grant });
    carryover.save('T:1', run1);
    const handle = carryover.get('T:1')!.match(/made_up_page_read\(.*\) -> stored as handle (\S+)/)?.[1];
    assert.ok(handle);

    let seen: any;
    const run2 = await new UnifiedAgentRunner(script([
      () => ({ text: '', functionCalls: [{ name: 'result_read', args: { handle, limit: 50 } }], telemetry }),
      (contents) => { seen = lastResults(contents)[0]; return finish('Deadline: Friday.'); }
    ]), dispatcher).run({ runId: 'run_2', trigger: 'slack_dm', instruction: 'when is the deadline?', toolGrant: grant });

    assert.ok(seen.slice.includes('LAST LINE: apply by Friday'), 'the whole result in one read');
    assert.equal(seen.remainingChars, 0);
    assert.equal(run2.toolCallsExecuted.length, 1);
    assert.equal(run2.output.slackMessage, 'Deadline: Friday.');
  });

  // Trace run_1792050718096_fhfh3zq: the 1.5k-token resume was generated three times (check, check
  // again, write: 30 s + 17 s + 12 s of rounds). A checked draft is now kept under a handle and any
  // owner-text write can name it; the write's own guard still checks the text behind the handle.
  describe('a checked draft is written by handle, not generated again (any owner-text tool)', () => {
    const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org';
    const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';
    let written: string[];
    const grant = { allowedToolNames: new Set(['owner_text_check', 'made_up_sources', 'made_up_letter_create']), allowConsequential: false };

    beforeEach(() => {
      process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
      const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, CLAIMS_BANK], missing: [] }));
      dispatcher = new ToolDispatcher(undefined, store, guard);
      written = [];
      dispatcher.registerTool(createOwnerTextCheckTool(guard));
      dispatcher.registerTool({
        name: 'made_up_sources', description: 's', schema: z.object({}), effectClass: 'READ',
        providesOwnerSources: () => true, execute: async () => ({ profile: PROFILE })
      });
      dispatcher.registerTool({
        name: 'made_up_letter_create', description: 'Creates a letter', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
        schema: z.object({ title: z.string(), content: z.string() }),
        ownerText: { kind: 'document', text: (p: any) => `${p.title}\n${p.content}`, field: 'content' },
        execute: async (p: any) => { written.push(p.content); return { ok: true }; }
      });
    });

    const runWith = (draft: string) => {
      let check: any;
      let writeResult: any;
      const model = script([
        () => ({ text: '', functionCalls: [{ name: 'made_up_sources', args: {} }, { name: 'owner_text_check', args: { kind: 'document', text: draft } }], telemetry }),
        (contents) => {
          check = lastResults(contents)[1];
          return { text: '', functionCalls: [{ name: 'made_up_letter_create', args: { title: 'Letter', content: check.draftHandle } }], telemetry };
        },
        (contents) => { writeResult = contents.at(-1).parts[0].functionResponse.response.result; return finish('Letter written.'); }
      ]);
      return new UnifiedAgentRunner(model, dispatcher).run({ runId: 'run_w', trigger: 'slack_dm', instruction: 'write a letter', toolGrant: grant })
        .then(result => ({ result, check, writeResult }));
    };

    it('writes the exact checked text when the write names the draft handle', async () => {
      const draft = 'Dear team,\nI built a support team of 12 people and would like to talk.\nJan Kowalski';
      const { result, check } = await runWith(draft);
      assert.match(check.draftHandle, /^res_owner_text_check_/);
      assert.match(check.nextStep, /pass draftHandle/);
      assert.deepEqual(written, [draft], 'the Doc holds the full draft, not the handle');
      assert.equal(result.toolCallsExecuted.at(-1)!.params.content, check.draftHandle, 'the model did not generate the draft again');
      assert.equal(result.output.slackMessage, 'Letter written.');
    });

    it('still refuses unsourced details in a draft written by handle', async () => {
      const { writeResult } = await runWith('Dear team,\nI built a support team of 40 people. Reach me at jan@made-up.example.com\nJan Kowalski');
      assert.deepEqual(written, []);
      assert.match(writeResult.error, /\[Claims Refusal\] Nothing was written/);
    });

    it('fails closed on a handle that is not a checked draft', async () => {
      const other = store.keep('run_x', 'made_up_page_read', 'some page');
      const context = { runId: 'r', isInteractive: true, toolGrant: grant, evidence: [] as string[], ownerSourcesRead: true };
      await assert.rejects(dispatcher.dispatch('made_up_letter_create', { title: 'L', content: other }, context as any), /\[Draft Refusal\]/);
      assert.deepEqual(written, []);
    });
  });
});

describe('Prompt rules that remove rounds survive prompt assembly', () => {
  // Trace run_1792050718096_fhfh3zq: 6 owner_sources_read calls one per round, then drive_search and
  // 3 docs_read of earlier resumes, although the inventory listed every Doc.
  it('asks for every read up front, one owner_sources_read with the whole list, no Drive search the inventory covers', async () => {
    const { buildPrefixInstruction } = await import('../agent/prefix-builder.js');
    const prompt = buildPrefixInstruction([], ['made-up inventory block']);
    assert.match(prompt, /before your first call, decide everything you will need to read and request it all in that step/);
    assert.match(prompt, /read them all with one owner_sources_read call \(every title in docs\) in your first step/);
    assert.match(prompt, /Do not drive_search or docs_read for sources or earlier versions of the document when the inventory lists what you need/);
    assert.match(prompt, /pass its draftHandle as the text of the write/);
    assert.match(prompt, /call result_read with only the handle/);
    assert.ok(prompt.includes('made-up inventory block'));
  });
});

// A follow-up in a thread used to spend a round on result_read for every short earlier result (the
// job posting in every job thread). Short carried results now arrive in full with the message; they
// ground details exactly as a result_read of the same handle would, and Ellie's own text still does not.
describe('short carried results go inline into a Slack follow-up (any tool)', () => {
  const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org';
  const POSTING = Array.from({ length: 60 }, (_, i) => `Requirement ${i}: made-up detail.`).join('\n') + '\nApply at https://jobs.example.test/role/77 LAST LINE';

  const thread = async (postingIsOwnText: boolean) => {
    const { SlackCoworkerService } = await import('../integrations/slack/coworker.js');
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    const store = new ResultStore(db);
    const guard = new ClaimsBankGuard(async () => '# Claims Bank\n1. Placeholder claim. [V]', 60_000, async () => ({ texts: [PROFILE], missing: [] }));
    const dispatcher = new ToolDispatcher(undefined, store, guard);
    const written: string[] = [];
    const called: string[] = [];
    dispatcher.registerTool(createResultReadTool(store));
    dispatcher.registerTool({
      name: 'made_up_page_read', description: 'Reads a page', effectClass: 'READ', notEvidence: postingIsOwnText,
      schema: z.object({ url: z.string() }), execute: async () => ({ text: POSTING })
    });
    dispatcher.registerTool({
      name: 'made_up_sources', description: 's', schema: z.object({}), effectClass: 'READ',
      providesOwnerSources: () => true, execute: async () => ({ profile: PROFILE })
    });
    dispatcher.registerTool({
      name: 'made_up_letter_create', description: 'Creates a letter', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({ content: z.string() }),
      ownerText: { kind: 'document', text: (p: any) => p.content, field: 'content' },
      execute: async (p: any) => { written.push(p.content); return { ok: true }; }
    });
    const dispatch = dispatcher.dispatch.bind(dispatcher);
    dispatcher.dispatch = ((name: string, params: any, ctx: any) => { called.push(name); return dispatch(name, params, ctx); }) as any;

    let followUpContents: any[] = [];
    let writeResult: any;
    const model = script([
      () => ({ text: '', functionCalls: [{ name: 'made_up_page_read', args: { url: 'https://jobs.example.test/role/77' } }], telemetry }),
      () => finish('Worth applying.'),
      (contents) => { followUpContents = structuredClone(contents); return { text: '', functionCalls: [{ name: 'made_up_sources', args: {} }], telemetry }; },
      () => ({ text: '', functionCalls: [{ name: 'made_up_letter_create', args: { content: 'Dear team, I am applying via https://jobs.example.test/role/77. Jan Kowalski' } }], telemetry }),
      (contents) => { writeResult = contents.at(-1).parts[0].functionResponse.response.result; return finish('Letter written.'); }
    ]);
    const posted: string[] = [];
    const slack: any = {
      addReaction: async () => ({}), removeReaction: async () => ({}),
      postMessage: async (m: any) => { posted.push(m.text); return { ok: true, ts: '1.1' }; },
      updateMessage: async (m: any) => { posted.push(m.text); return { ok: true }; },
      getConversationReplies: async () => []
    };
    const ledger: any = { getLatestStagedByThreadTs: () => null, listStagedByRun: () => [] };
    const service = new SlackCoworkerService(slack, ledger, new UnifiedAgentRunner(model, dispatcher), 'http://x', undefined, new ThreadCarryoverRepository(db, store));
    const base = { type: 'message', user: process.env.SLACK_OWNER_USER_ID || 'U1', channel: 'D1', channel_type: 'im', thread_ts: '100.1' };
    await service.handleUserMessage({ ...base, text: 'should I apply?', ts: '100.2' } as any);
    called.length = 0;
    await service.handleUserMessage({ ...base, text: 'write the cover letter', ts: '100.3' } as any);
    return { followUpContents, written, called, posted, writeResult };
  };

  it('the follow-up gets the short posting in full, needs no result_read, and the posting grounds the letter', async () => {
    const { followUpContents, written, called, posted } = await thread(false);
    assert.match(JSON.stringify(followUpContents), /LAST LINE/, 'full carried text in the first request');
    assert.deepEqual(called, ['made_up_sources', 'made_up_letter_create']);
    assert.equal(written.length, 1);
    assert.ok(posted.some(t => t?.includes('Letter written.')), JSON.stringify(posted));
  });

  it('an inlined result that repeats Ellie\'s own text still grounds nothing', async () => {
    const { written, writeResult } = await thread(true);
    assert.deepEqual(written, []);
    assert.match(writeResult.error, /\[Claims Refusal\]/);
  });
});
