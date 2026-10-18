import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { initializeAppDatabase, initializeLedgerDatabase } from '../storage/schema.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore } from '../storage/result-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { createOwnerTextCheckTool } from '../tools/owner-text-check-tool.js';
import { buildRuntime } from '../runtime/build-runtime.js';
import { ToolExecutionContext } from '../types/tool.js';
import { mustFixFindings } from '../governance/humanizer-scanner.js';

const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org';
const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';

describe('owner_text_check (dry run of the write checks, any owner-text tool)', () => {
  let dispatcher: ToolDispatcher;
  let written: string[];
  let context: ToolExecutionContext;

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(new ActionLedgerRepository(ledgerDb), new ResultStore(appDb), guard);
    written = [];
    dispatcher.registerTool(createOwnerTextCheckTool(guard));
    dispatcher.registerTool({
      name: 'made_up_sources', description: 's', schema: z.object({}), effectClass: 'READ',
      providesOwnerSources: () => true, execute: async () => ({ profile: PROFILE })
    });
    dispatcher.registerTool({
      name: 'made_up_note_send', description: 'Sends a note', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({ body: z.string() }),
      ownerText: { kind: 'message', text: (p: any) => p.body },
      execute: async (p: any) => { written.push(p.body); return { ok: true }; }
    });
    context = {
      runId: 'r', isInteractive: true, evidence: ['write a note'],
      toolGrant: { allowedToolNames: new Set(['owner_text_check', 'made_up_sources', 'made_up_note_send']), allowConsequential: false }
    };
  });

  it('reports exactly what the write would refuse, without writing anything', async () => {
    await dispatcher.dispatch('made_up_sources', {}, context);
    const draft = 'I built a support team of 40 people. Portfolio: https://made-up.example.com/work';

    const check: any = await dispatcher.dispatch('owner_text_check', { kind: 'message', text: draft }, context);
    assert.equal(check.wouldBeWritten, false);
    assert.equal(check.mustFix.length, 2);
    assert.match(check.nextStep, /Fix only the items listed/);
    assert.deepEqual(written, []);

    let writeError = '';
    await dispatcher.dispatch('made_up_note_send', { body: draft }, context).catch(e => { writeError = e.message; });
    for (const refusal of check.mustFix) assert.ok(writeError.includes(refusal), 'the write refuses for the same reasons');
    assert.deepEqual(written, [], 'the check echoing the draft did not make the invented link count as read');

    const clean: any = await dispatcher.dispatch('owner_text_check', { kind: 'message', text: 'I built a support team of 12 people.' }, context);
    assert.equal(clean.wouldBeWritten, true);
    assert.equal(clean.mustFix, undefined);
    assert.match(clean.nextStep, /^Clean\. Write it now/);
  });

  it('says when the sources have not been read yet', async () => {
    const check: any = await dispatcher.dispatch('owner_text_check', { kind: 'document', text: 'Hello.' }, context);
    assert.equal(check.wouldBeWritten, false);
    assert.match(check.sourcesRead, /owner_sources_read/);
  });

  it('is registered in the runtime', () => {
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    assert.equal(runtime.dispatcher.getTool('owner_text_check')?.notEvidence, true);
  });
});

describe('Humanization scanner: only must-fix lines reach the model', () => {
  it('keeps English Tier A hits and Tier B clusters, drops Tier R and the manual list', () => {
    const out = [
      'HUMANIZATION CHECK v4.3 | non-fiction | 264 words', '',
      'TIER A: fix every hit (1)', '  L16   P12  em dash (non-fiction): That shift freed', '',
      'TIER B CLUSTERS: 3+ weak tells in one paragraph (1); 4 weak hits total', '  L9    P03 x; P05 y', '',
      'TIER R: read, fix only the real ones (2)', '  L1    M  comma/period ratio 2.41', '  L14   P08  triad candidate: abc', '',
      'MANUAL (critique step, see patterns.md): P10', '  P24 vague quantities', '', 'RESULT: FAIL (1 Tier A, 1 Tier B clusters)'
    ].join('\n');
    assert.deepEqual(mustFixFindings(out, 'en'), ['L16   P12  em dash (non-fiction): That shift freed', 'L9    P03 x; P05 y']);
  });

  it('keeps Polish BŁĄD lines, drops SPRAWDŹ', () => {
    const out = '3:5  BŁĄD     pauza —: tekst\n4:1  SPRAWDŹ  słownictwo AI: kluczowy\n\nBłędy: 1, do sprawdzenia: 1';
    assert.deepEqual(mustFixFindings(out, 'pl'), ['3:5  BŁĄD     pauza —: tekst']);
  });
});
