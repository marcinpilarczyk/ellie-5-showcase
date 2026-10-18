import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import JSZip from 'jszip';
import { initializeAppDatabase } from '../storage/schema.js';
import { ResultStore } from '../storage/result-store.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ModelRouter, ModelCallResponse } from '../models/model-router.js';
import { ClaimsBankGuard } from '../governance/claims-bank.js';
import { createDocumentTools, DocumentStoreDeps } from '../tools/document-tools.js';
import { Block, readingOrder } from '../documents/blocks.js';
import { contactHref, docxParagraphs, renderDocx } from '../documents/render-docx.js';
import { PdfEngine, lastPageFillProblems, pageProblems, pdfToolsInstalled, readingOrderProblems } from '../documents/pdf.js';
import { EXECUTIVE_EDITORIAL, getAutoFitPresets } from '../documents/themes.js';
import { VisualCheck, createVisualCheck } from '../documents/visual-check.js';
import { VisualBlock, visualReadingOrder } from '../documents/visual-blocks.js';
import { A4_HEIGHT_PX, computeAutoFitScale, htmlParagraphs, renderVisualHtml } from '../documents/render-html-pdf.js';
import { buildRuntime } from '../runtime/build-runtime.js';

// Formatted documents, build step 3: blocks -> themed DOCX in Drive, guarded and read back. Made-up person and job.

const PROFILE = 'Jan Kowalski\nEmail: jan.kowalski@example.org\nLinkedIn: https://www.linkedin.com/in/jan-kowalski-real/\nKraków, Poland';
const RECORD = 'Career record. 25+ years in customer operations. Head of Customer Success at Northwind (2016 - 2024).';
const CLAIMS_BANK = '# Claims Bank\n1. Built a support team of 12 people. [V]';

const telemetry = { model: 'gemini-3.8-flash', promptTokens: 1, cachedTokens: 0, thinkingTokens: 0, candidatesTokens: 1, totalTokens: 2, durationMs: 1 };
const script = (steps: Array<(contents: any[]) => ModelCallResponse>) => {
  let i = 0;
  return { generate: async (contents: any[]) => steps[Math.min(i++, steps.length - 1)](contents) } as unknown as ModelRouter;
};
const call = (name: string, args: any): ModelCallResponse => ({ text: '', functionCalls: [{ name, args }], telemetry });
const lastResult = (contents: any[]) => contents.at(-1).parts[0].functionResponse.response.result;

function resume(contact: string[]): Block[] {
  return [
    { type: 'header', name: 'Jan Kowalski', headline: 'Customer Operations Leader | Support at Scale', contact },
    { type: 'heading', text: 'Professional Summary' },
    { type: 'paragraph', text: 'Operations leader with **25+ years** in customer operations, most recently Head of Customer Success at Northwind.' },
    { type: 'heading', text: 'Experience' },
    {
      type: 'role', title: 'Head of Customer Success', employer: 'Northwind', dates: '2016 – 2024', location: 'Kraków, Poland',
      context: 'Made-up logistics software company.',
      bullets: ['**One team, one queue.** Built a support team of 12 people.', 'Moved escalations from chat to tickets.']
    },
    { type: 'heading', text: 'Core Capabilities' },
    { type: 'keyvalue', lines: [{ label: 'Operations', text: 'Escalation design · SLAs · Vendor management' }] },
    { type: 'bullets', items: ['Polish: native', 'English: fluent'] },
    { type: 'note', text: 'I consent to the processing of my personal data for this recruitment process.' }
  ];
}

/**
 * A stand-in for LibreOffice + poppler: the "PDF" carries the DOCX paragraphs; pages and extracted text
 * come from settable functions, so a test can make a render too long or out of order.
 */
function fakePdf() {
  const state = {
    conversions: 0,
    pages: (_paras: string[], _conversion: number) => 2,
    text: (paras: string[], _conversion: number) => paras.join('\n')
  };
  const parse = (pdf: Buffer) => JSON.parse(pdf.toString('utf8').replace(/^FAKEPDF/, '')) as { paras: string[]; n: number };
  const engine: PdfEngine = {
    convert: async docx => Buffer.from('FAKEPDF' + JSON.stringify({ paras: await docxParagraphs(docx), n: ++state.conversions })),
    pageCount: async pdf => { const p = parse(pdf); return state.pages(p.paras, p.n); },
    text: async pdf => { const p = parse(pdf); return state.text(p.paras, p.n); },
    pageImages: async pdf => {
      const p = parse(pdf);
      return Array.from({ length: state.pages(p.paras, p.n) }, (_, i) => Buffer.from(`page ${i + 1} of render ${p.n}`));
    }
  };
  return { engine, state };
}

/** A stand-in for the model's look at the pages: answers per render, records what it was shown. */
function fakeVisualCheck() {
  const state = {
    seen: [] as Array<{ pages: string[]; kind: string }>,
    answer: (_render: number): string[] | Error => []
  };
  const check: VisualCheck = async (pages, kind) => {
    state.seen.push({ pages: pages.map(p => p.toString()), kind });
    const answer = state.answer(state.seen.length);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { check, state };
}

/** An in-memory Drive: folders by path, files by id. */
function fakeDrive() {
  const pdf = fakePdf();
  const visual = fakeVisualCheck();
  const folders = new Map<string, string>([['', 'root_folder']]);
  const files = new Map<string, { name: string; mimeType: string; data: Buffer; parentId: string }>();
  const deps: DocumentStoreDeps = {
    ownerFolderId: async () => 'root_folder',
    ensureFolder: async (rootId, path) => {
      assert.equal(rootId, 'root_folder');
      if (!folders.has(path)) folders.set(path, `folder_${folders.size}`);
      return folders.get(path)!;
    },
    upload: async (name, mimeType, data, parentId) => {
      const id = `file_${files.size + 1}`;
      files.set(id, { name, mimeType, data, parentId });
      return { id, name, webViewLink: `https://drive.example.test/${id}` };
    },
    download: async fileId => files.get(fileId)!.data,
    pdf: pdf.engine,
    visualCheck: visual.check
  };
  return { deps, folders, files, pdf: pdf.state, visual: visual.state };
}

describe('document_render: blocks to a themed DOCX in Drive (class: every document kind)', () => {
  let dispatcher: ToolDispatcher;
  let runTraceStore: RunTraceStore;
  let drive: ReturnType<typeof fakeDrive>;
  const grant = { allowedToolNames: new Set(['made_up_sources', 'document_render']), allowConsequential: false };

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    runTraceStore = new RunTraceStore(db);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, RECORD, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(undefined, new ResultStore(db), guard);
    drive = fakeDrive();
    dispatcher.registerTool({
      name: 'made_up_sources', description: 's', schema: z.object({}), effectClass: 'READ',
      providesOwnerSources: () => true, execute: async () => ({ profile: PROFILE, record: RECORD })
    });
    createDocumentTools(drive.deps).forEach(t => dispatcher.registerTool(t));
  });

  it('refuses invented contact details, then writes the sourced resume to the chosen folder, read back in block order', async () => {
    const invented = resume(['Kraków, Poland', 'jan.kowalski@made-up.io', 'linkedin.com/in/jankowalski']);
    const sourced = resume(['Kraków, Poland', 'jan.kowalski@example.org', 'linkedin.com/in/jan-kowalski-real']);
    let refusal = '';
    let written: any;
    const args = (blocks: Block[]) => ({ kind: 'resume', title: 'Jan Kowalski - Contoso Resume', folder: 'Projects/JOB_SEARCH/Resumes', blocks });

    const result = await new UnifiedAgentRunner(script([
      () => call('made_up_sources', {}),
      () => call('document_render', args(invented)),
      (contents) => { refusal = lastResult(contents).error; return call('document_render', args(sourced)); },
      (contents) => { written = lastResult(contents); return call('finish', { status: 'DONE', message: `Resume: ${written.webViewLink}` }); }
    ]), dispatcher, undefined, runTraceStore).run({ runId: 'run_doc', trigger: 'slack_dm', instruction: 'tailor my resume for Contoso', toolGrant: grant });

    assert.equal(result.status, 'COMPLETED');
    assert.match(refusal, /Claims Refusal/);
    for (const item of ['jan.kowalski@made-up.io', 'linkedin.com/in/jankowalski']) assert.ok(refusal.includes(item), `refusal names ${item}`);

    // Two files reached Drive, both from the sourced version: the DOCX and its PDF, in the requested folder.
    assert.equal(drive.files.size, 2);
    const pdf = drive.files.get('file_2')!;
    assert.equal(pdf.name, 'Jan Kowalski - Contoso Resume.pdf');
    assert.equal(pdf.mimeType, 'application/pdf');
    assert.equal(written.pdfLink, 'https://drive.example.test/file_2');
    assert.equal(written.pages, 2);
    assert.match(written.readBack.detail, /PDF \(file_2\): 2 pages, text in block order/);
    const file = drive.files.get('file_1')!;
    assert.equal(file.name, 'Jan Kowalski - Contoso Resume.docx');
    assert.equal(file.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(file.parentId, drive.folders.get('Projects/JOB_SEARCH/Resumes'));
    assert.equal(written.webViewLink, 'https://drive.example.test/file_1');
    assert.equal(written.readBack.status, 'VERIFIED');

    // The file reads in block order, with the sourced contact line.
    const paragraphs = await docxParagraphs(file.data);
    assert.deepEqual(paragraphs, readingOrder(sourced));
    assert.equal(paragraphs[2], 'Kraków, Poland  |  jan.kowalski@example.org  |  linkedin.com/in/jan-kowalski-real');
    assert.equal(paragraphs[6], 'Head of Customer Success');
    assert.equal(paragraphs[7], 'Northwind  |  2016 – 2024  |  Kraków, Poland');
  });

  it('refuses malformed blocks without writing anything', async () => {
    const context = { runId: 'r', isInteractive: true, toolGrant: grant, evidence: [] as string[], ownerSourcesRead: true };
    await assert.rejects(
      dispatcher.dispatch('document_render', { kind: 'memo', title: 'Memo', blocks: [{ type: 'heading', text: 'Status' }, { type: 'role', title: 'Lead' }] }, context),
      /Document Refusal.*Block 2 \(role\) needs employer/
    );
    await assert.rejects(
      dispatcher.dispatch('document_render', { kind: 'memo', title: 'Memo', folder: '../elsewhere', blocks: [{ type: 'paragraph', text: 'Hi.' }] }, context),
      /plain path/
    );
    assert.equal(drive.files.size, 0);
  });

  it('read-back reports ABSENT when the stored file does not match the blocks', async () => {
    drive.deps.pdf = undefined;
    drive.deps.download = async () => renderDocx({ kind: 'memo', theme: 'executive-editorial', title: 'Other', blocks: [{ type: 'paragraph', text: 'Something else.' }] });
    const context = { runId: 'r3', isInteractive: true, toolGrant: grant, evidence: [] as string[], ownerSourcesRead: true };
    const out: any = await dispatcher.dispatch('document_render', { kind: 'memo', title: 'Status memo', blocks: [{ type: 'heading', text: 'Status' }, { type: 'paragraph', text: 'All on track.' }] }, context);
    assert.equal(out.readBack.status, 'ABSENT');
    assert.match(out.readBack.detail, /Expected 2 paragraphs, found 1/);
    assert.equal(drive.folders.has('Documents'), true, 'no folder given: the default folder');
  });

  const resumeArgs = (blocks: Block[]) => ({ kind: 'resume', title: 'Jan Kowalski - Resume', blocks });
  const sourcedResume = () => resume(['Kraków, Poland', 'jan.kowalski@example.org']);

  it('a PDF of the wrong length across all presets goes back to the model once with the finding; the fixed render writes both files', async () => {
    drive.pdf.pages = p => (p.length >= 16 ? 3 : 2);
    let finding = '';
    let written: any;
    const result = await new UnifiedAgentRunner(script([
      () => call('made_up_sources', {}),
      () => call('document_render', resumeArgs(sourcedResume())),
      (contents) => { finding = lastResult(contents).error; return call('document_render', resumeArgs(sourcedResume().slice(0, -1))); },
      (contents) => { written = lastResult(contents); return call('finish', { status: 'DONE', message: `DOCX ${written.webViewLink}, PDF ${written.pdfLink}` }); }
    ]), dispatcher, undefined, runTraceStore).run({ runId: 'run_pages', trigger: 'slack_dm', instruction: 'resume please', toolGrant: grant });

    assert.match(finding, /^\[Document Check\] Nothing was written\. The PDF is 3 pages; a resume must be exactly 2\./);
    assert.equal(written.pages, 2);
    assert.equal(written.readBack.status, 'VERIFIED');
    assert.equal(drive.files.size, 2, 'only the fixed render was uploaded');
    assert.equal(result.output.finishStatus, 'DONE');
  });

  it('auto-fits a slight page overflow (3 -> 2 pages) or underflow (1 -> 2 pages) using elastic theme presets without bouncing back to the model', async () => {
    // 1. Slight overflow: initial render is 3 pages, second tighter preset brings it to 2 pages.
    drive.pdf.pages = (_p, n) => (n < 3 ? 3 : 2);
    let writtenOverflow: any;
    const resOverflow = await new UnifiedAgentRunner(script([
      () => call('made_up_sources', {}),
      () => call('document_render', resumeArgs(sourcedResume())),
      (contents) => { writtenOverflow = lastResult(contents); return call('finish', { status: 'DONE', message: `PDF ${writtenOverflow.pdfLink}` }); }
    ]), dispatcher, undefined, runTraceStore).run({ runId: 'run_autofit_tight', trigger: 'slack_dm', instruction: 'resume please', toolGrant: grant });

    assert.equal(resOverflow.output.finishStatus, 'DONE');
    assert.equal(writtenOverflow.pages, 2);
    assert.equal(writtenOverflow.autoFitPreset, 'compact-2');
    assert.equal(writtenOverflow.readBack.status, 'VERIFIED');

    // 2. Slight underflow: initial render is 1 page, first looser preset brings it to 2 pages.
    drive.pdf.conversions = 0;
    drive.pdf.pages = (_p, n) => (n === 1 ? 1 : 2);
    let writtenUnderflow: any;
    const resUnderflow = await new UnifiedAgentRunner(script([
      () => call('made_up_sources', {}),
      () => call('document_render', resumeArgs(sourcedResume())),
      (contents) => { writtenUnderflow = lastResult(contents); return call('finish', { status: 'DONE', message: `PDF ${writtenUnderflow.pdfLink}` }); }
    ]), dispatcher, undefined, runTraceStore).run({ runId: 'run_autofit_loose', trigger: 'slack_dm', instruction: 'resume please', toolGrant: grant });

    assert.equal(resUnderflow.output.finishStatus, 'DONE');
    assert.equal(writtenUnderflow.pages, 2);
    assert.equal(writtenUnderflow.autoFitPreset, 'spacious-1');
  });

  it('a second failed check in the run is BLOCKED: nothing written, the model is told to stop and say what is wrong', async () => {
    // The extracted text puts the contact line above the name: an ATS would read the page out of order.
    drive.pdf.text = paras => [paras[2], paras[0], paras[1], ...paras.slice(3)].join('\n');
    const errors: string[] = [];
    const result = await new UnifiedAgentRunner(script([
      () => call('made_up_sources', {}),
      () => call('document_render', resumeArgs(sourcedResume())),
      (contents) => { errors.push(lastResult(contents).error); return call('document_render', resumeArgs(sourcedResume().slice(0, -1))); },
      (contents) => { errors.push(lastResult(contents).error); return call('finish', { status: 'BLOCKED', message: errors[1] }); }
    ]), dispatcher, undefined, runTraceStore).run({ runId: 'run_blocked', trigger: 'slack_dm', instruction: 'resume please', toolGrant: grant });

    assert.match(errors[0], /^\[Document Check\].*reads before "Customer Operations Leader/);
    assert.match(errors[1], /^\[Document BLOCKED\] Nothing was written.*finish with status BLOCKED/);
    assert.equal(drive.files.size, 0);
    assert.equal(result.output.finishStatus, 'BLOCKED');
  });
});

describe('visual check of the page images (step 5)', () => {
  let dispatcher: ToolDispatcher;
  let drive: ReturnType<typeof fakeDrive>;
  const grant = { allowedToolNames: new Set(['document_render']), allowConsequential: false };
  const context = (runId: string) => ({ runId, isInteractive: true, toolGrant: grant, evidence: [] as string[], ownerSourcesRead: true });
  const memo = (extra = '') => ({ kind: 'memo', title: 'Status memo', blocks: [{ type: 'heading', text: 'Status' }, { type: 'paragraph', text: `All on track.${extra}` }] });

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, RECORD, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(undefined, new ResultStore(db), guard);
    drive = fakeDrive();
    createDocumentTools(drive.deps).forEach(t => dispatcher.registerTool(t));
  });

  it('sees every page of a render that passed the structural checks; a defect goes back once, then BLOCKED', async () => {
    drive.visual.answer = () => ['Page 1: the heading "Status" sits at the bottom with its paragraph on page 2.'];
    await assert.rejects(dispatcher.dispatch('document_render', memo(), context('r_vis')), /^Error: \[Document Check\] Nothing was written\. Layout: Page 1: the heading "Status"/);
    await assert.rejects(dispatcher.dispatch('document_render', memo(' Still.'), context('r_vis')), /\[Document BLOCKED\].*Layout: Page 1/);
    assert.deepEqual(drive.visual.seen[0], { pages: ['page 1 of render 1', 'page 2 of render 1'], kind: 'memo' });
    assert.equal(drive.files.size, 0);
  });

  it('is not asked about a render that already failed the page count', async () => {
    drive.pdf.pages = () => 3;
    await assert.rejects(dispatcher.dispatch('document_render', { ...memo(), kind: 'resume' }, context('r_pages')), /exactly 2/);
    assert.equal(drive.visual.seen.length, 0);
  });

  it('a failed model call does not stop the write; the result says the check did not run', async () => {
    drive.visual.answer = () => new Error('model unavailable');
    const out: any = await dispatcher.dispatch('document_render', memo(), context('r_down'));
    assert.equal(out.visualCheck, 'not run: model unavailable');
    assert.equal(drive.files.size, 2);
    drive.visual.answer = () => [];
    const ok: any = await dispatcher.dispatch('document_render', memo(' Again.'), context('r_ok'));
    assert.equal(ok.visualCheck, 'passed');
  });

  it('the model call sends each page as a PNG and reads the JSON verdict', async () => {
    let request: any;
    const router = {
      generate: async (contents: any[], config: any) => {
        request = { contents, config };
        return { text: '{"ok":false,"problems":["Page 2: bullet stranded at top"]}', telemetry };
      }
    } as unknown as ModelRouter;
    const problems = await createVisualCheck(router)([Buffer.from('p1'), Buffer.from('p2')], 'resume');
    assert.deepEqual(problems, ['Page 2: bullet stranded at top']);
    const parts = request.contents[0].parts;
    assert.match(parts[0].text, /rendered resume \(2 page images/);
    assert.deepEqual(parts.slice(1).map((p: any) => p.inlineData.mimeType), ['image/png', 'image/png']);
    assert.equal(parts[1].inlineData.data, Buffer.from('p1').toString('base64'));
    assert.equal(request.config.source, 'document_visual_check');
    assert.ok(request.config.responseSchema);

    // A resume's last page must not be a few lines of overflow; other kinds may end on a short page.
    assert.match(parts[0].text, /last page with only a few lines/);
    assert.doesNotMatch(parts[0].text, /do not report the last page being partly empty/);
    await createVisualCheck(router)([Buffer.from('p1')], 'memo');
    assert.match(request.contents[0].parts[0].text, /do not report the last page being partly empty/);
    assert.doesNotMatch(request.contents[0].parts[0].text, /last page with only a few lines/);
  });
});

describe('PDF read-back rules', () => {
  it('page rules by kind', () => {
    assert.deepEqual(pageProblems('resume', 2), []);
    assert.match(pageProblems('resume', 1)[0], /exactly 2/);
    assert.match(pageProblems('cover_letter', 2)[0], /must fit 1/);
    assert.deepEqual(pageProblems('one_pager', 1), []);
    assert.match(pageProblems('one_pager', 2)[0], /exactly 1/);
    assert.deepEqual(pageProblems('pitch_sheet', 1), []);
    assert.deepEqual(pageProblems('infographic', 1), []);
    assert.deepEqual(pageProblems('memo', 5), []);
  });

  it('reading order: wrapped lines, capitals and ligatures pass; missing and out-of-order text is named', () => {
    const expected = ['Jan Kowalski', 'Professional Summary', 'Moved escalations from chat to tickets, fixing the flow.'];
    assert.deepEqual(readingOrderProblems(expected, 'JAN KOWALSKI\nPROFESSIONAL SUMMARY\n• Moved escalations from chat\nto tickets, ﬁxing the ﬂow.'), []);
    assert.match(
      readingOrderProblems(expected, 'PROFESSIONAL SUMMARY\nJan Kowalski\nMoved escalations from chat to tickets, fixing the flow.')[0],
      /"Professional Summary" reads before "Jan Kowalski"/
    );
    assert.match(readingOrderProblems(expected, 'Jan Kowalski\nProfessional Summary')[0], /does not contain "Moved escalations/);
    // Live 2026-10-15 (run_1792069441463_xxmoig7): pdftotext joins a line ending in a hyphen without it.
    assert.deepEqual(readingOrderProblems(['Ops: follow-the-sun support, ITIL and PRINCE2'], 'Ops: follow-the-\nsun support, ITIL and PRINCE2'.replace('-\n', '')), []);
  });

  it('cross-platform pdfToolsInstalled supports both colon and semicolon PATH delimiters', () => {
    assert.equal(pdfToolsInstalled('/nonexistent/a;/nonexistent/b', ';'), false);
    assert.equal(pdfToolsInstalled('/nonexistent/a:/nonexistent/b', ':'), false);
  });
});

describe('executive-editorial theme in the DOCX (with hyperlinks, right-aligned role tab stops, and elastic presets)', () => {
  it('sets the theme fonts, sizes and colours, wraps contact emails/URLs in hyperlinks, right-aligns role dates/locations, uses no tables, and embeds every face it uses', async () => {
    const docx = await renderDocx({
      kind: 'resume',
      theme: 'executive-editorial',
      title: 'T',
      blocks: resume(['Kraków, Poland', 'jan.kowalski@example.org', 'linkedin.com/in/jan-kowalski-real'])
    });
    const zip = await JSZip.loadAsync(docx);
    const xml = await zip.file('word/document.xml')!.async('string');
    const docRels = await zip.file('word/_rels/document.xml.rels')!.async('string');

    assert.ok(!xml.includes('<w:tbl>'), 'no tables');
    assert.ok(!xml.includes('<w:drawing'), 'no images or shapes');
    // Name: Merriweather 22 pt, accent, caps. Section heading: Merriweather 10.5 pt caps with a 0.75 pt accent rule.
    assert.match(xml, /<w:rFonts w:ascii="Merriweather"[^>]*\/>[\s\S]*?<w:caps\/>[\s\S]*?<w:color w:val="17324D"\/>[\s\S]*?<w:sz w:val="44"\/>[\s\S]*?<w:t[^>]*>Jan Kowalski<\/w:t>/);
    assert.match(xml, /<w:bottom w:val="single" w:color="17324D" w:sz="6"[^>]*\/>/);
    // Body: Google Sans Text 10.5 pt, ink colour.
    assert.match(xml, /<w:rFonts w:ascii="Google Sans Text"[^>]*\/>[\s\S]*?<w:color w:val="222222"\/>[\s\S]*?<w:sz w:val="21"\/>/);
    // A4 page.
    assert.match(xml, /<w:pgSz w:w="11906" w:h="16838"/);

    // Clickable hyperlinks in header.contact: email and LinkedIn wrapped in <w:hyperlink> with external rels.
    assert.equal(contactHref('jan.kowalski@example.org'), 'mailto:jan.kowalski@example.org');
    assert.equal(contactHref('linkedin.com/in/jan-kowalski-real'), 'https://linkedin.com/in/jan-kowalski-real');
    assert.equal(contactHref('Kraków, Poland'), undefined);
    assert.match(xml, /<w:hyperlink\b[^>]*\br:id="rId[-a-zA-Z0-9_]+"/);
    assert.match(docRels, /Target="mailto:jan\.kowalski@example\.org" TargetMode="External"/);
    assert.match(docRels, /Target="https:\/\/linkedin\.com\/in\/jan-kowalski-real" TargetMode="External"/);

    // Right-aligned tab stop on role header at right content margin (210mm - 2*18mm = 174mm = 9865 twips) and <w:tab/>.
    assert.match(xml, /<w:tab w:val="right" w:pos="9865"\/>/);
    assert.match(xml, /<w:tab\/>/);

    // Micro-typesetting presets stay within elastic bounds (margins 14-19mm, lineSpacing 1.08-1.20).
    const tighter = getAutoFitPresets(EXECUTIVE_EDITORIAL, 'tighter');
    const looser = getAutoFitPresets(EXECUTIVE_EDITORIAL, 'looser');
    assert.equal(tighter.length, 3);
    assert.equal(looser.length, 2);
    for (const p of [...tighter, ...looser]) {
      assert.ok(p.theme.page.marginTopMm >= 14 && p.theme.page.marginTopMm <= 19);
      assert.ok(p.theme.lineSpacing >= 1.08 && p.theme.lineSpacing <= 1.20);
      assert.ok(p.theme.bullet.spaceAfterPt >= 1.5 && p.theme.bullet.spaceAfterPt <= 3);
      assert.ok(p.theme.heading.spaceBeforePt >= 9 && p.theme.heading.spaceBeforePt <= 14);
    }

    const fontTable = await zip.file('word/fontTable.xml')!.async('string');
    assert.match(fontTable, /<w:font w:name="Google Sans Text">.*<w:embedRegular .*<w:embedBold .*<w:embedItalic .*<w:embedBoldItalic /);
    assert.match(fontTable, /<w:font w:name="Merriweather">.*<w:embedRegular .*<w:embedBold /);
    const odttf = Object.keys(zip.files).filter(n => n.endsWith('.odttf'));
    assert.equal(odttf.length, 6);

    // Embedded fonts are obfuscated per ECMA-376: undoing it with the declared key gives a TrueType file.
    const [, rid, key] = fontTable.match(/<w:embedRegular r:id="(rId\d+)" w:fontKey="(\{[^}]+\})"/)!;
    const rels = await zip.file('word/_rels/fontTable.xml.rels')!.async('string');
    const target = rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))![1];
    const data = Buffer.from(await zip.file(`word/${target}`)!.async('nodebuffer'));
    const bytes = key.replace(/[{}-]/g, '').match(/../g)!.map(h => parseInt(h, 16)).reverse();
    for (let i = 0; i < 32; i++) data[i] ^= bytes[i % 16];
    assert.equal(data.readUInt32BE(0), 0x00010000);

    assert.match(await zip.file('word/settings.xml')!.async('string'), /<w:embedTrueTypeFonts\/>/);
  });
});

describe('page breaks in lists', () => {
  it('keeps a role title with its first bullet and the last two bullets of every list together', async () => {
    const docx = await renderDocx({
      kind: 'resume', theme: 'executive-editorial', title: 'T', blocks: [
        { type: 'role', title: 'Lead', employer: 'Northwind', bullets: ['One.', 'Two.', 'Three.', 'Four.'] },
        { type: 'bullets', items: ['Alpha.', 'Beta.', 'Gamma.'] }
      ]
    });
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    const keepNext = (text: string) => {
      const p = xml.match(new RegExp(`<w:p>(?:(?!<w:p>)[\\s\\S])*?>${text}</w:t>`))![0];
      return /<w:keepNext\/>/.test(p);
    };
    assert.deepEqual(['One.', 'Two.', 'Three.', 'Four.'].map(keepNext), [true, false, true, false]);
    assert.deepEqual(['Alpha.', 'Beta.', 'Gamma.'].map(keepNext), [false, true, false]);
  });
});

describe('document_render and visual_document_render are registered with the owner-text guard', () => {
  it('declares owner text and writes a resource whose reads are not evidence', () => {
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    for (const toolName of ['document_render', 'visual_document_render']) {
      const tool = runtime.dispatcher.getTool(toolName)!;
      assert.equal(tool.ownerText?.kind, 'document');
      assert.equal(tool.writesResource?.({} as any, { fileId: 'f1' }), 'f1');
    }
  });
});

describe('Visual One-Pager / Pitch Sheet / Infographic Engine (Phase 5.2)', () => {
  let dispatcher: ToolDispatcher;
  let runTraceStore: RunTraceStore;
  let drive: ReturnType<typeof fakeDrive>;
  const grant = { allowedToolNames: new Set(['made_up_sources', 'visual_document_render']), allowConsequential: false };

  function samplePitchBlocks(authorMeta: string): VisualBlock[] {
    return [
      {
        type: 'banner_header',
        kicker: 'PROPOSAL · WORKFLOW AUTOMATION',
        meta: authorMeta,
        title: 'Client Follow-Up & Retention Assistant',
        subtitle: 'Turning scattered client history into a calm daily follow-up list.',
        quote: 'Every morning you see who needs a check-in and why — with a ready draft waiting for your approval.'
      },
      {
        type: 'step_flow',
        title: 'How the 4-Step Workflow Operates',
        steps: [
          { number: '1', icon: 'database', title: 'Reads Client Records', description: 'Scans recent notes and booking dates.' },
          { number: '2', icon: 'list', title: 'Builds Daily Queue', description: 'Selects 3 to 5 priority clients.' },
          { number: '3', icon: 'flag', title: 'Prepares Drafts', description: 'Writes tailored check-in messages.' },
          { number: '4', icon: 'check-circle', title: 'You Approve & Send', description: 'Nothing leaves without your click.', highlight: true }
        ]
      },
      {
        type: 'split_grid',
        ratio: '55-45',
        left: {
          type: 'status_table',
          icon: 'calendar',
          title: 'Morning Priority List',
          date: 'Tuesday · 08:30',
          badge: '3 priority items',
          rows: [
            { label: 'Anna Nowak', context: 'Follow-up due · Last session 3w ago', status: 'Ready to send', tone: 'success' },
            { label: 'Piotr Wiśniewski', context: 'Rescheduled twice · Check availability', status: 'Call today', tone: 'warning' },
            { label: 'Katarzyna Dąbrowska', context: 'New inquiry · Needs intake form', status: 'Urgent reply', tone: 'danger' }
          ],
          callout: {
            title: 'Sample Draft Ready for Approval',
            text: 'Hi Anna, checking in three weeks after our last session to see how the new routine feels.',
            meta: 'Channel: Email / SMS · Awaiting owner approval'
          }
        },
        right: {
          type: 'benefit_card',
          title: 'What Changes Day-to-Day',
          subtitle: 'Immediate operational relief',
          items: [
            { icon: 'clock', title: 'Zero Evening Admin', description: 'No more scrolling through messages at 9 PM.' },
            { icon: 'sparkles', title: 'Consistent Follow-Through', description: 'Every client gets timely attention.' },
            { icon: 'user-check', title: 'Full Personal Control', description: 'You review and edit every word before sending.' }
          ]
        }
      },
      {
        type: 'icon_strip',
        title: 'Governance & Human-in-the-Loop Boundaries',
        columns: [
          { icon: 'user-check', title: 'Approval Required', text: 'Never sends messages autonomously.' },
          { icon: 'lock', title: 'Private Data', text: 'Client notes stay inside your workspace.' },
          { icon: 'shield', title: 'Audit Trail', text: 'Every action is logged and reversible.' }
        ],
        note: 'Assumption: works with your existing calendar and contact sheet without migrating software.'
      },
      {
        type: 'cta_footer',
        kicker: 'NEXT STEP · 2-WEEK PILOT',
        author: 'Prepared by Jan Kowalski ·Head of Customer Success at Northwind',
        pitch: 'Let us run a lightweight 14-day pilot on 20 active clients and measure saved admin hours.',
        calloutTitle: 'Pilot Hypothesis',
        calloutText: 'Cuts daily follow-up prep to under 10 minutes while recovering 2-3 dormant bookings per week.',
        disclaimer: 'Concept brief for discussion · No automated external sends enabled during pilot Step 1.'
      }
    ];
  }

  beforeEach(() => {
    process.env.ELLIE_OWNER_FULL_NAME = 'Jan Kowalski';
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);
    runTraceStore = new RunTraceStore(db);
    const guard = new ClaimsBankGuard(async () => CLAIMS_BANK, 60_000, async () => ({ texts: [PROFILE, RECORD, CLAIMS_BANK], missing: [] }));
    dispatcher = new ToolDispatcher(undefined, new ResultStore(db), guard);
    drive = fakeDrive();
    drive.pdf.pages = () => 1;
    dispatcher.registerTool({
      name: 'made_up_sources', description: 's', schema: z.object({}), effectClass: 'READ',
      providesOwnerSources: () => true, execute: async () => ({ profile: PROFILE, record: RECORD })
    });
    createDocumentTools(drive.deps).forEach(t => dispatcher.registerTool(t));
  });

  it('guards owner claims, renders HTML+SVG and 1-page PDF, runs visual check, and verifies reading order on read-back', async () => {
    const invented = samplePitchBlocks('Prepared by Jan Kowalski · jan.kowalski@invented.io');
    const sourced = samplePitchBlocks('Prepared by Jan Kowalski · jan.kowalski@example.org · Kraków, Poland');
    let refusal = '';
    let written: any;

    const result = await new UnifiedAgentRunner(script([
      () => call('made_up_sources', {}),
      () => call('visual_document_render', {
        kind: 'pitch_sheet',
        theme: 'warm-editorial',
        title: 'Client Follow-Up Assistant - Pitch Sheet',
        folder: 'Projects/Pitches',
        blocks: invented
      }),
      (contents) => {
        refusal = lastResult(contents).error;
        return call('visual_document_render', {
          kind: 'pitch_sheet',
          theme: 'warm-editorial',
          title: 'Client Follow-Up Assistant - Pitch Sheet',
          folder: 'Projects/Pitches',
          blocks: sourced
        });
      },
      (contents) => {
        written = lastResult(contents);
        return call('finish', { status: 'DONE', message: `Pitch sheet: ${written.pdfLink}` });
      }
    ]), dispatcher, undefined, runTraceStore).run({
      runId: 'run_visual_pitch',
      trigger: 'slack_dm',
      instruction: 'make a visual 1-pager pitch sheet',
      toolGrant: grant
    });

    assert.equal(result.status, 'COMPLETED');
    assert.match(refusal, /\[Claims Refusal\].*jan\.kowalski@invented\.io/);

    // Both HTML and 1-page PDF were uploaded and verified in reading order.
    assert.equal(drive.files.size, 2);
    assert.equal(written.pages, 1);
    assert.equal(written.visualCheck, 'passed');
    assert.equal(written.readBack.status, 'VERIFIED');
    assert.match(written.readBack.detail, /PDF \(file_2\): 1 page, text in block order/);

    const htmlFile = drive.files.get('file_1')!;
    const htmlText = htmlFile.data.toString('utf8');
    assert.match(htmlText, /@page\s*\{\s*size:\s*A4 portrait;\s*margin:\s*0;/);
    assert.match(htmlText, /data-icon="database"/);
    assert.match(htmlText, /v-step-card--highlight/);
    assert.match(htmlText, /v-badge--success/);
    assert.match(htmlText, /v-cta-footer/);
    assert.deepEqual(htmlParagraphs(htmlText), visualReadingOrder(sourced));
  });

  it('deterministic 1-page auto-fit scales down overflow and scales up underflow into the 92%-100% page-1 band', () => {
    // 1. Sweet spot (95% of 1122.5px): stays at 1.0 scale
    const sweet = computeAutoFitScale(A4_HEIGHT_PX * 0.95);
    assert.equal(sweet.scaleSpace, 1);
    assert.equal(sweet.scaleFont, 1);
    assert.equal(sweet.fitsSinglePage, true);

    // 2. Overflow (1250px > 1122.5px): compresses spacing, font, and card padding so it fits page 1
    const overflow = computeAutoFitScale(1250);
    assert.ok(overflow.scaleSpace < 1);
    assert.ok(overflow.scaleFont < 1);
    assert.ok(overflow.cardPaddingPx < 14);
    assert.equal(overflow.fitsSinglePage, true);
    assert.ok(overflow.estimatedFillRatio <= 1);

    // 3. Underflow (800px < 0.92 * 1122.5px): expands spacing and padding toward 92%-100%
    const underflow = computeAutoFitScale(800);
    assert.ok(underflow.scaleSpace > 1);
    assert.ok(underflow.cardPaddingPx >= 14);
    assert.ok(underflow.estimatedFillRatio >= 0.85 && underflow.estimatedFillRatio <= 1);
  });

  it('deterministic lastPageFillProblems flags sparse page 2 on resumes and passes balanced pages', () => {
    // 1. Sparse page 2 on a resume (<5 lines or <250 chars) is flagged immediately
    const sparsePdfText = 'Page 1 has plenty of detailed content for the resume.\n'.repeat(25) +
      '\x0c' +
      'Only one line at top of page 2.';
    const sparseProblems = lastPageFillProblems('resume', sparsePdfText);
    assert.equal(sparseProblems.length, 1);
    assert.match(sparseProblems[0], /The last page of the resume has only 1 line/);

    // 2. Substantive page 2 on a resume passes cleanly
    const balancedPdfText = 'Page 1 has plenty of detailed content for the resume.\n'.repeat(25) +
      '\x0c' +
      'Northwind Logistics · Senior Technical Program Manager\n' +
      '• Led 14 engineers across three continents.\n' +
      '• Scaled real-time routing pipeline to 200k daily deliveries.\n' +
      '• Mentored five engineering team leads.\n' +
      '• Improved p99 latency by 35% using streaming architectures.\n' +
      'Education: Warsaw University of Technology, M.Sc. Computer Science';
    const balancedProblems = lastPageFillProblems('resume', balancedPdfText);
    assert.deepEqual(balancedProblems, []);

    // 3. Other document kinds (cover_letter, memo, one_pager) are not flagged for short last pages
    assert.deepEqual(lastPageFillProblems('cover_letter', sparsePdfText), []);
    assert.deepEqual(lastPageFillProblems('memo', sparsePdfText), []);
    assert.deepEqual(lastPageFillProblems('one_pager', sparsePdfText), []);
  });
});


