import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelCallResponse } from '../models/model-router.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { buildRuntime } from '../runtime/build-runtime.js';
import { createOwnerSourceTools, OwnerSources } from '../tools/owner-source-tools.js';
import { docPlainText } from '../integrations/google/compact.js';

const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org';
const RECORD = 'Career record. 25+ years in customer operations.';
const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';
const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };

describe('Writing for the owner starts from the owner sources (any tool)', () => {
  let dispatcher: ToolDispatcher;
  let runTraceStore: RunTraceStore;
  let written: string[];

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    runTraceStore = new RunTraceStore(appDb);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, RECORD, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(new ActionLedgerRepository(ledgerDb), new ResultStore(appDb), guard);
    written = [];
    dispatcher.registerTool({
      name: 'made_up_sources', description: 'Owner sources', schema: z.object({}), effectClass: 'READ',
      providesOwnerSources: () => true, keepsFullResult: true,
      execute: async () => ({ profile: PROFILE, record: RECORD, rules: 'R'.repeat(20_000) })
    });
    dispatcher.registerTool({
      name: 'made_up_brochure_write', description: 'Writes a brochure', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({ content: z.string() }),
      ownerText: { kind: 'document', text: (p: any) => p.content },
      execute: async (p: any) => { written.push(p.content); return { id: 'doc_1' }; }
    });
  });

  it('refuses a write before the sources were read, then writes after the model reads them in full', async () => {
    const letter = 'Jan Kowalski | jan.kowalski@example.org\n25+ years in customer operations.';
    let call = 0;
    const seen: any[] = [];
    const mockRouter = {
      generate: async (contents: any[]): Promise<ModelCallResponse> => {
        call++;
        if (call > 1) seen.push(contents.at(-1).parts[0].functionResponse.response.result);
        if (call === 1) return { text: '', functionCalls: [{ name: 'made_up_brochure_write', args: { content: letter } }], telemetry };
        if (call === 2) return { text: '', functionCalls: [{ name: 'made_up_sources', args: {} }], telemetry };
        if (call === 3) return { text: '', functionCalls: [{ name: 'made_up_brochure_write', args: { content: letter } }], telemetry };
        return { text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Written.' } }], telemetry };
      }
    } as unknown as ModelRouter;

    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, runTraceStore);
    const result = await runner.run({
      runId: 'test_sources_first', trigger: 'slack_dm', instruction: 'write my bio',
      toolGrant: { allowedToolNames: new Set(['made_up_sources', 'made_up_brochure_write']), allowConsequential: false }
    });

    assert.match(seen[0].error, /sources first: call made_up_sources/);
    assert.equal(seen[1].rules.length, 20_000, 'the sources reach the model in full, not as a Result Store preview');
    assert.equal(seen[1].handle, undefined);
    assert.deepEqual(written, [letter]);
    assert.equal(result.status, 'COMPLETED');
    const calls = JSON.parse(runTraceStore.getTrace('test_sources_first')!.tools_called);
    assert.deepEqual(calls.map((c: any) => c.tool), ['made_up_brochure_write', 'made_up_sources', 'made_up_brochure_write']);
  });

  it('keepsFullResult has a ceiling: a huge result still goes to the Result Store', async () => {
    dispatcher.registerTool({
      name: 'made_up_huge_sources', description: 'h', schema: z.object({}), effectClass: 'READ', keepsFullResult: true,
      execute: async () => ({ text: 'x'.repeat(60_000) })
    });
    const res: any = await dispatcher.dispatch('made_up_huge_sources', {}, { runId: 'r', isInteractive: true, toolGrant: { allowedToolNames: new Set(['made_up_huge_sources']), allowConsequential: false } });
    assert.equal(res.isStored, true);
  });
});

describe('owner_sources_read (Docs discovered in the owner folder, nothing named in code)', () => {
  const folder = [
    { id: 'd1', title: 'Some Profile', path: '' },
    { id: 'd2', title: 'How I Write Letters', path: '/Writing' }
  ];
  const texts: Record<string, string> = { d1: PROFILE, d2: 'Rules: one page.', linked_record: 'Detailed Record\n' + RECORD };
  let reads = 0;
  const sources = () => new OwnerSources({
    folderId: async () => 'folder_1',
    listDocs: async id => (id === 'folder_1' ? folder : []),
    readDoc: async id => { reads++; return texts[id]; },
    linkedDocIds: () => ['linked_record', 'd1']
  });

  it('lists every Doc in the folder plus linked ones, then reads the ones asked for in full', async () => {
    const [tool] = createOwnerSourceTools(sources());
    const ctx = { runId: 'r', isInteractive: true, toolGrant: { allowedToolNames: new Set(['owner_sources_read']), allowConsequential: false } };

    const index: any = await tool.execute({}, ctx);
    assert.deepEqual(index.docs.map((d: any) => `${d.folder}|${d.title}`), ['/|Some Profile', '/Writing|How I Write Letters', '(linked)|Detailed Record']);
    assert.equal(tool.providesOwnerSources!({}), false, 'listing is not reading');

    const read: any = await tool.execute({ docs: ['profile', 'write letters', 'nope'] }, ctx);
    assert.deepEqual(read.docs.map((d: any) => d.text), [PROFILE, 'Rules: one page.']);
    assert.deepEqual(read.notFound, ['nope']);
    assert.equal(tool.providesOwnerSources!({ docs: ['profile'] }), true);
  });

  it('gives the claims guard every Doc, cached, and names what could not be read', async () => {
    reads = 0;
    const s = sources();
    const all = await s.allTexts();
    assert.equal(all.texts.length, 3);
    await s.allTexts();
    assert.equal(reads, 3, 'second call is cached');

    const broken = new OwnerSources({ folderId: async () => undefined, listDocs: async () => [], readDoc: async () => '', linkedDocIds: () => [] });
    assert.match((await broken.allTexts()).missing[0], /folder/);
  });

  it('is registered in the runtime as the owner source provider', () => {
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    assert.equal(typeof runtime.dispatcher.getTool('owner_sources_read')?.providesOwnerSources, 'function');
  });
});

describe('Google Doc text (every Doc read)', () => {
  const para = (t: string) => ({ paragraph: { elements: [{ textRun: { content: t } }] } });
  const table = (rows: string[][]) => ({ table: { tableRows: rows.map(r => ({ tableCells: r.map(c => ({ content: [para(`${c}\n`)] })) })) } });

  it('keeps table rows and reads a one-tab Doc exactly as its body', () => {
    const body = { content: [para('Rules\n'), table([['Section', 'Length'], ['Summary', '3 lines']]), para('End\n')] };
    assert.equal(docPlainText({ body }), 'Rules\nSection | Length\nSummary | 3 lines\nEnd');
    assert.equal(docPlainText({ tabs: [{ tabProperties: { title: 'Main' }, documentTab: { body } }] }), 'Rules\nSection | Length\nSummary | 3 lines\nEnd');
  });

  it('reads every tab, including child tabs', () => {
    const doc = { tabs: [
      { tabProperties: { title: 'One' }, documentTab: { body: { content: [para('first\n')] } },
        childTabs: [{ tabProperties: { title: 'Two' }, documentTab: { body: { content: [para('second\n')] } } }] }
    ] };
    assert.equal(docPlainText(doc), '=== Tab: One ===\nfirst\n\n=== Tab: Two ===\nsecond');
  });
});
