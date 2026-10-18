import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, APP_MIGRATIONS, migrate } from '../storage/schema.js';
import { ResultStore } from '../storage/result-store.js';
import { AuthoredResources } from '../storage/authored-resources.js';
import { ThreadCarryoverRepository } from '../storage/thread-carryover-repo.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelCallResponse } from '../models/model-router.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { createResultReadTool } from '../tools/result-tools.js';
import { buildRuntime } from '../runtime/build-runtime.js';

// Trace run_1792048853034_vn796ce: a follow-up read Ellie's own earlier resumes and run traces and
// used them as evidence, so details she once invented could ground a new letter. Her own text is
// never a source, whichever tool returns it, in this run or a later one.

const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org';
const RECORD = 'Career record. 25+ years in customer operations. Head of Customer Success at Northwind (2016 - 2024).';
const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';
const INVENTED = 'Jan Kowalski. 15+ years leading support. Former VP of Growth at Fabrikam.';
const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };

describe('Evidence never includes Ellie\'s own text (any tool, any run)', () => {
  let db: DatabaseSync;
  let store: ResultStore;
  let authored: AuthoredResources;
  let dispatcher: ToolDispatcher;
  let docs: Map<string, string>;
  let written: string[];

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    store = new ResultStore(db);
    authored = new AuthoredResources(db);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, RECORD, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(undefined, store, guard, authored);
    written = [];
    docs = new Map([
      ['doc_old_letter', `${INVENTED} ${'Earlier letter body. '.repeat(30)}`],
      ['doc_posting', 'Senior Director of Support at Contoso. The role asks for 10+ years of experience.']
    ]);
    // An Ellie-written Doc from before this run (as the migration backfills them)
    authored.record('doc_old_letter', 'made_up_doc_create', 'run_earlier');

    dispatcher.registerTool(createResultReadTool(store));
    dispatcher.registerTool({
      name: 'made_up_own_log', description: 'Ellie\'s own recent work', schema: z.object({}), effectClass: 'READ', notEvidence: true,
      execute: async () => ({ earlierDraft: `${INVENTED} ${'Log line. '.repeat(40)}` })
    });
    dispatcher.registerTool({
      name: 'made_up_doc_read', description: 'Reads a doc', effectClass: 'READ',
      schema: z.object({ documentId: z.string() }),
      readsResource: (p: any) => p.documentId,
      execute: async (p: any) => ({ documentId: p.documentId, text: docs.get(p.documentId) })
    });
    dispatcher.registerTool({
      name: 'made_up_doc_create', description: 'Creates a doc', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({ text: z.string() }),
      ownerText: { kind: 'document', text: (p: any) => p.text },
      writesResource: (_p: any, r: any) => r?.documentId,
      execute: async (p: any) => {
        written.push(p.text);
        const documentId = `doc_new_${written.length}`;
        docs.set(documentId, p.text);
        return { documentId };
      }
    });
  });

  const grant = { allowedToolNames: new Set(['result_read', 'made_up_own_log', 'made_up_doc_read', 'made_up_doc_create']), allowConsequential: false };

  it('a follow-up run cannot ground claims in an earlier run\'s own-text results reopened by handle; a real source still can', async () => {
    const carryover = new ThreadCarryoverRepository(db, store);
    const script = (steps: Array<(contents: any[]) => ModelCallResponse>) => {
      let i = 0;
      return { generate: async (contents: any[]) => steps[Math.min(i++, steps.length - 1)](contents) } as unknown as ModelRouter;
    };
    const finish = (): ModelCallResponse => ({ text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Done.' } }], telemetry });

    // Run 1: reads Ellie's own log and her old letter Doc, writes nothing.
    const run1 = await new UnifiedAgentRunner(script([
      () => ({ text: '', functionCalls: [{ name: 'made_up_own_log', args: {} }, { name: 'made_up_doc_read', args: { documentId: 'doc_old_letter' } }], telemetry }),
      finish
    ]), dispatcher).run({ runId: 'run_1', trigger: 'slack_dm', instruction: 'write a cover letter', toolGrant: grant });
    assert.deepEqual(run1.toolCallsExecuted.map(c => c.notEvidence), [true, true]);
    carryover.save('T:1', run1);

    const summary = carryover.get('T:1')!;
    const logHandle = summary.match(/made_up_own_log\(.*\) -> stored as handle (\S+)/)?.[1];
    const letterHandle = summary.match(/made_up_doc_read\(.*\) -> stored as handle (\S+)/)?.[1];
    assert.ok(logHandle && letterHandle, summary);

    // Run 2 ("again"): reopens both by handle, tries the old claims, then reads the posting.
    let refusal = '';
    const run2 = await new UnifiedAgentRunner(script([
      () => ({ text: '', functionCalls: [{ name: 'result_read', args: { handle: logHandle } }, { name: 'result_read', args: { handle: letterHandle } }], telemetry }),
      () => ({ text: '', functionCalls: [{ name: 'made_up_doc_create', args: { text: INVENTED } }], telemetry }),
      (contents) => {
        refusal = contents.at(-1).parts[0].functionResponse.response.result.error;
        return { text: '', functionCalls: [{ name: 'made_up_doc_read', args: { documentId: 'doc_posting' } }], telemetry };
      },
      () => ({ text: '', functionCalls: [{ name: 'made_up_doc_create', args: { text: 'Jan Kowalski, 25+ years in customer operations. Applying to a role that asks for 10+ years of experience.' } }], telemetry }),
      finish
    ]), dispatcher).run({ runId: 'run_2', trigger: 'slack_dm', instruction: 'again', toolGrant: grant });

    // What reached the Doc: only the sourced letter.
    assert.deepEqual(written, ['Jan Kowalski, 25+ years in customer operations. Applying to a role that asks for 10+ years of experience.']);
    assert.match(refusal, /\[Claims Refusal\] Nothing was written/);
    assert.ok(refusal.includes('15+ years') && refusal.includes('VP of Growth'), refusal);
    assert.equal(run2.status, 'COMPLETED');
  });

  it('a Doc Ellie wrote in this run is not a source when read back; any other Doc is', async () => {
    const context = { runId: 'r', isInteractive: true, toolGrant: grant, evidence: [] as string[] };
    const created: any = await dispatcher.dispatch('made_up_doc_create', { text: 'Jan Kowalski, Head of Customer Success at Northwind.' }, context);
    assert.equal(dispatcher.isEvidence('made_up_doc_read', { documentId: created.documentId }), false);
    assert.equal(dispatcher.isEvidence('made_up_doc_read', { documentId: 'doc_posting' }), true);

    // Stored own-text results stay non-evidence when read later
    const big: any = await dispatcher.dispatch('made_up_own_log', {}, context);
    assert.ok(!context.evidence.some(e => e.includes('Fabrikam')));
    if (big.isStored) assert.equal(dispatcher.isEvidence('result_read', { handle: big.handle }), false);
    assert.equal(dispatcher.isEvidence('result_read', { handle: 'res_unknown' }), false);
  });

  it('the migration marks Docs Ellie created and stored own-text results from before it', () => {
    const old = new DatabaseSync(':memory:');
    migrate(old, APP_MIGRATIONS.filter(m => m.version < 5), 'app');
    old.prepare("INSERT INTO run_traces (run_id, trigger, status, delivery_mode, tools_called) VALUES ('run_a', 'slack_dm', 'COMPLETED', 'SLACK_MESSAGE', ?)")
      .run(JSON.stringify([{ tool: 'docs_create', params: { title: 't' }, result: { documentId: 'doc_made_by_ellie' } }, { tool: 'docs_read', params: {}, result: { documentId: 'doc_owner' } }]));
    const ins = old.prepare('INSERT INTO tool_results (handle, run_id, tool_name, content, preview, size_bytes) VALUES (?, ?, ?, ?, ?, 1)');
    ins.run('res_a', 'run_a', 'docs_read', JSON.stringify({ documentId: 'doc_made_by_ellie', text: 'x' }), 'p');
    ins.run('res_b', 'run_a', 'docs_read', JSON.stringify({ documentId: 'doc_owner', text: 'x' }), 'p');
    ins.run('res_c', 'run_a', 'trace_inspect_recent', '{}', 'p');
    migrate(old, APP_MIGRATIONS, 'app');

    const reg = new AuthoredResources(old);
    assert.equal(reg.has('doc_made_by_ellie'), true);
    assert.equal(reg.has('doc_owner'), false);
    const s = new ResultStore(old);
    assert.deepEqual(['res_a', 'res_b', 'res_c'].map(h => s.isEvidence(h)), [false, true, false]);
  });

  it('the real tools declare it: Doc reads and creates, and the tools that return Ellie\'s own work', () => {
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    const tool = (n: string) => runtime.dispatcher.getTool(n)!;
    assert.ok(tool('docs_read').readsResource && tool('docs_create').writesResource);
    for (const n of ['owner_text_check', 'trace_inspect_recent', 'repo_read_file', 'repo_list_and_search', 'memory_list_candidates']) {
      assert.equal(tool(n)?.notEvidence, true, n);
    }
  });
});
