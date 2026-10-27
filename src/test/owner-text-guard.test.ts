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
import { ClaimsBankGuard, extractIdentityDetails, reviewOwnerText } from '../governance/claims-bank.js';
import { buildRuntime } from '../runtime/build-runtime.js';

// Owner sources as the guard loads them (stand-ins for the profile, record and Claims Bank Docs).
const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org\nLinkedIn: https://www.linkedin.com/in/jan-kowalski-real/\nPhone: +48 600 100 200';
const RECORD = 'Career record. 25+ years in customer operations. Head of Customer Success at Northwind (2016 - 2024).';
const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';

const OWNER_TOKENS = ['jan', 'kowalski'];
const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };

function guard(): ClaimsBankGuard {
  return new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, RECORD, CLAIMS_BANK], missing: [] }));
}

describe('Owner text guard (any tool that writes for the owner)', () => {
  let ledgerRepo: ActionLedgerRepository;
  let runTraceStore: RunTraceStore;
  let dispatcher: ToolDispatcher;
  let written: string[];

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const appDb = new DatabaseSync(':memory:');
    const ledgerDb = new DatabaseSync(':memory:');
    initializeAppDatabase(appDb);
    initializeLedgerDatabase(ledgerDb);
    ledgerRepo = new ActionLedgerRepository(ledgerDb);
    runTraceStore = new RunTraceStore(appDb);
    dispatcher = new ToolDispatcher(ledgerRepo, new ResultStore(appDb), guard());
    written = [];

    dispatcher.registerTool({
      name: 'made_up_posting_read', description: 'Reads a job posting', schema: z.object({}), effectClass: 'READ',
      execute: async () => ({ text: 'Senior Director of Support at Contoso. Apply: talent@contoso.example.com, https://contoso.example.com/jobs/42?ref=feed. 10+ years of experience.' })
    });
    dispatcher.registerTool({
      name: 'made_up_brochure_write', description: 'Writes a brochure', effectClass: 'INTERNAL_REVERSIBLE_WRITE',
      schema: z.object({ heading: z.string(), content: z.string() }),
      ownerText: { kind: 'document', text: (p: any) => `${p.heading}\n${p.content}` },
      execute: async (p: any) => { written.push(p.content); return { id: `doc_${written.length}` }; }
    });
    dispatcher.registerTool({
      name: 'made_up_letter_send', description: 'Sends a letter', effectClass: 'CONSEQUENTIAL',
      schema: z.object({ body: z.string() }),
      ownerText: { kind: 'message', text: (p: any) => p.body },
      execute: async (p: any) => { written.push(p.body); return { sent: true }; }
    });
  });

  it('refuses invented contact details, years and links, writes nothing, and lets the model retry with sourced ones', async () => {
    const invented = 'Jan Kowalski | jan.kowalski@made-up.io | linkedin.com/in/jankowalski | +48 511 222 333\n15+ years leading support. Former VP of Growth at Fabrikam.';
    const sourced = 'Jan Kowalski | jan.kowalski@example.org | linkedin.com/in/jan-kowalski-real | +48 600-100-200\n25+ years in customer operations; Head of Customer Success at Northwind.\n' +
      'Applying for Senior Director of Support (https://contoso.example.com/jobs/42), via talent@contoso.example.com. Role asks for 10+ years of experience.';

    let call = 0;
    let refusal = '';
    const mockRouter = {
      generate: async (contents: any[]): Promise<ModelCallResponse> => {
        call++;
        if (call === 1) return { text: '', functionCalls: [{ name: 'made_up_posting_read', args: {} }], telemetry };
        if (call === 2) return { text: '', functionCalls: [{ name: 'made_up_brochure_write', args: { heading: 'Profile', content: invented } }], telemetry };
        if (call === 3) {
          refusal = contents.at(-1).parts[0].functionResponse.response.result.error;
          return { text: '', functionCalls: [{ name: 'made_up_brochure_write', args: { heading: 'Profile', content: sourced } }], telemetry };
        }
        return { text: '', functionCalls: [{ name: 'finish', args: { status: 'DONE', message: 'Written.' } }], telemetry };
      }
    } as unknown as ModelRouter;

    const runner = new UnifiedAgentRunner(mockRouter, dispatcher, undefined, runTraceStore);
    const result = await runner.run({
      runId: 'test_owner_text_run',
      trigger: 'slack_dm',
      instruction: 'write my profile brochure for the Contoso role',
      toolGrant: { allowedToolNames: new Set(['made_up_posting_read', 'made_up_brochure_write']), allowConsequential: false }
    });

    // What reached the "document": only the sourced version.
    assert.deepEqual(written, [sourced]);

    // The model was told exactly what was unverified.
    assert.match(refusal, /\[Claims Refusal\] Nothing was written/);
    for (const item of ['jan.kowalski@made-up.io', 'linkedin.com/in/jankowalski', '+48 511 222 333', '15+ years', 'VP of Growth']) {
      assert.ok(refusal.includes(item), `refusal names ${item}: ${refusal}`);
    }
    assert.ok(!refusal.includes('talent@contoso'), 'the recruiter address came from the posting read in this run');

    // The trace shows the refused call and the successful one.
    const trace = runTraceStore.getTrace('test_owner_text_run')!;
    const calls = JSON.parse(trace.tools_called);
    assert.equal(calls.length, 3);
    assert.match(JSON.stringify(calls[1].result), /Claims Refusal/);
    assert.equal(result.status, 'COMPLETED');
  });

  it('an address that names the owner needs the owner sources, even if the run read it somewhere', async () => {
    dispatcher.registerTool({
      name: 'made_up_old_draft_read', description: 'Reads an old draft', schema: z.object({}), effectClass: 'READ',
      execute: async () => ({ text: 'Contact: jan.kowalski@made-up.io' })
    });
    const context = { runId: 'r', isInteractive: true, toolGrant: { allowedToolNames: new Set(['made_up_old_draft_read', 'made_up_brochure_write']), allowConsequential: false }, evidence: [] as string[] };
    await dispatcher.dispatch('made_up_old_draft_read', {}, context);
    await assert.rejects(
      dispatcher.dispatch('made_up_brochure_write', { heading: 'Contact', content: 'Write to jan.kowalski@made-up.io' }, context),
      /jan\.kowalski@made-up\.io.*naming/
    );
    assert.deepEqual(written, []);
  });

  it('messages are also checked against the Claims Bank, before anything is staged', async () => {
    const context = { runId: 'r2', isInteractive: true, toolGrant: { allowedToolNames: new Set(['made_up_letter_send']), allowConsequential: true }, evidence: [] as string[] };
    await assert.rejects(
      dispatcher.dispatch('made_up_letter_send', { body: 'I built a support team of 40 people.' }, context),
      /Claims Refusal.*40 people/
    );
    assert.equal(ledgerRepo.listStagedByRun('r2').length, 0);

    const staged: any = await dispatcher.dispatch('made_up_letter_send', { body: 'I built a support team of 12 people. Reach me at jan.kowalski@example.org.' }, context);
    assert.equal(staged.status, 'STAGED_FOR_APPROVAL');

    // Approval runs the Claims Bank check again, then the tool.
    const approved = await dispatcher.executeApproved('made_up_letter_send', staged.payload, context);
    assert.deepEqual(approved.result, { sent: true });
    assert.deepEqual(written, ['I built a support team of 12 people. Reach me at jan.kowalski@example.org.']);
  });

  it('fails closed when a tool declares owner text and no guard is configured', async () => {
    const bare = new ToolDispatcher(ledgerRepo);
    bare.registerTool({
      name: 'made_up_note_write', description: 'n', effectClass: 'INTERNAL_REVERSIBLE_WRITE', schema: z.object({ t: z.string() }),
      ownerText: { kind: 'document', text: (p: any) => p.t },
      execute: async () => ({ ok: true })
    });
    await assert.rejects(
      bare.dispatch('made_up_note_write', { t: 'hello' }, { runId: 'r3', isInteractive: true, toolGrant: { allowedToolNames: new Set(['made_up_note_write']), allowConsequential: false } }),
      /no claims guard is configured/
    );
  });

  it('fails closed for documents when the Claims Bank cannot be read', async () => {
    const unavailable = new ClaimsBankGuard(
      async () => { throw new Error('bank unavailable'); },
      60_000,
      async () => ({ texts: [PROFILE], missing: [] })
    );
    const review = await reviewOwnerText(unavailable, 'document', 'A document with unverified claims.', {
      evidence: [],
      identity: true
    });
    assert.ok(review.refusals.some(refusal => /CLAIMS_BANK_UNAVAILABLE/.test(refusal)));
  });

  it('extracts identity details but not dates, year ranges or bare words', () => {
    const found = extractIdentityDetails(
      'Head of the project. 2016 - 2024, 01.2019 - 12.2024, 2015-2019 2020-2024. Meeting on 2026-10-14 at 10:30. Worked 3 years there. ' +
      'Director, Customer Experience. CEO. Over 20 years in SaaS. www.jan-kowalski.pl/cv',
      OWNER_TOKENS
    );
    assert.deepEqual(found.map(d => `${d.kind}:${d.raw}`), [
      'url:www.jan-kowalski.pl/cv',
      'experience:20 years',
      'title:Director, Customer Experience',
      'title:CEO'
    ]);
    assert.equal(found[0].aboutOwner, true);
  });
});

describe('Owner text declarations (every registered tool)', () => {
  it('every write tool that takes free text either declares owner text or is listed as internal', () => {
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    const TEXT_FIELDS = ['body', 'bodyText', 'text', 'content', 'markdown', 'html', 'blocks'];
    // Ellie's own state (memory, skills, reminders, management), never shown to anyone as the owner's words.
    const INTERNAL = new Set(['memory_save', 'memory_record_candidate', 'memory_manage', 'memory_promote_candidate', 'skill_edit', 'reminder_set', 'reminder_manage', 'routine_manage', 'sentinel_manage', 'queue_manage', 'nudge_settings_manage', 'workspace_alias_manage', 'cost_and_budget_manage', 'space_publish', 'waiting_track', 'waiting_resolve', 'project_state_update']);
    const missing: string[] = [];
    for (const tool of runtime.dispatcher.getAllTools()) {
      if (tool.effectClass === 'READ' || tool.ownerText || INTERNAL.has(tool.name)) continue;
      const shape = (tool.schema as any).shape ?? (tool.schema as any)._def?.schema?.shape ?? {};
      if (Object.keys(shape).some(k => TEXT_FIELDS.includes(k))) missing.push(tool.name);
    }
    assert.deepEqual(missing, []);
    for (const name of ['gmail_draft', 'gmail_send', 'proton_draft', 'proton_send', 'docs_create', 'docs_append']) {
      assert.ok(runtime.dispatcher.getTool(name)!.ownerText, `${name} declares owner text`);
    }
  });
});
