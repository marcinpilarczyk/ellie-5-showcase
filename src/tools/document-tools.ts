import { ToolDefinition } from '../types/tool.js';
import { DocumentSpec, documentSchema, readingOrder, validateBlocks } from '../documents/blocks.js';
import { DOCX_MIME, compareReadingOrder, docxHasTable, docxParagraphs, renderDocx } from '../documents/render-docx.js';
import { PAGE_RULES, PdfEngine, lastPageFillProblems, pageProblems, readingOrderProblems } from '../documents/pdf.js';
import { getAutoFitPresets, THEMES } from '../documents/themes.js';
import { VisualCheck } from '../documents/visual-check.js';
import {
   validateVisualBlocks,
  VisualDocumentSpec,
  visualDocumentSchema,
  visualReadingOrder
} from '../documents/visual-blocks.js';
import { HTML_MIME, htmlParagraphs, renderHtmlPdf } from '../documents/render-html-pdf.js';

/** Where rendered documents go: a folder path inside the owner's folder (the folder that holds the config Doc). */
export interface DocumentStoreDeps {
  ownerFolderId: () => Promise<string | undefined>;
  ensureFolder: (rootId: string, path: string) => Promise<string>;
  upload: (name: string, mimeType: string, data: Buffer, parentId: string) => Promise<{ id: string; name: string; webViewLink?: string }>;
  download: (fileId: string) => Promise<Buffer>;
  /** DOCX to PDF and the PDF read-back; without it only the DOCX is written. */
  pdf?: PdfEngine;
  /** Optional custom HTML-to-PDF converter for visual one-pagers; defaults to headless browser or deps.pdf.convert. */
  htmlPdf?: (html: Buffer, spec: VisualDocumentSpec) => Promise<Buffer>;
  /** A model's look at the page images; needs pdf. */
  visualCheck?: VisualCheck;
  isAvailable?: () => boolean;
}

export const DEFAULT_DOCUMENT_FOLDER = 'Documents';
const PDF_MIME = 'application/pdf';

function folderPath(raw: string | undefined): string {
  const segments = (raw ?? DEFAULT_DOCUMENT_FOLDER).split('/').map(s => s.trim()).filter(Boolean);
  if (segments.length === 0) return DEFAULT_DOCUMENT_FOLDER;
  if (segments.some(s => s === '.' || s === '..')) throw new Error(`Folder "${raw}" must be a plain path inside the owner's folder.`);
  return segments.join('/');
}

/** The text the owner-text guard checks: the file name and every paragraph in reading order. */
export function documentOwnerText(p: DocumentSpec): string {
  return [p.title, ...readingOrder(p.blocks ?? [])].join('\n');
}

/** The text the owner-text guard checks for visual one-pagers/infographics: title and all block text in reading order. */
export function visualDocumentOwnerText(p: VisualDocumentSpec): string {
  return [p.title, ...visualReadingOrder(p.blocks ?? [])].join('\n');
}

/** What the PDF read-back finds wrong: page count for the kind, last page fill balance, and text out of block order. */
async function pdfProblems(
  engine: PdfEngine,
  pdf: Buffer,
  kind: string,
  expectedOrder: string[]
): Promise<{ pages: number; problems: string[] }> {
  try {
    const [pages, text] = await Promise.all([engine.pageCount(pdf), engine.text(pdf)]);
    return {
      pages,
      problems: [
        ...pageProblems(kind, pages),
        ...lastPageFillProblems(kind, text),
        ...readingOrderProblems(expectedOrder, text)
      ]
    };
  } catch (err: any) {
    return { pages: 0, problems: [`PDF inspection error: ${err.message}`] };
  }
}

function recordCheckFailure(failedChecks: Map<string, number>, runId: string, problems: string[], toolName: string): never {
  const failures = (failedChecks.get(runId) ?? 0) + 1;
  failedChecks.set(runId, failures);
  if (failedChecks.size > 200) failedChecks.delete(failedChecks.keys().next().value!);
  if (failures === 1) {
    throw new Error(`[Document Check] Nothing was written. ${problems.join(' ')} Fix this in the blocks and call ${toolName} once more.`);
  }
  throw new Error(
    `[Document BLOCKED] Nothing was written; the PDF failed the checks again. ${problems.join(' ')} ` +
    'Do not render again in this run: finish with status BLOCKED and tell the owner exactly what is wrong.'
  );
}

export function createDocumentTools(deps: DocumentStoreDeps): ToolDefinition[] {
  // Failed PDF checks per run: the first goes back to the model with the findings, the second is BLOCKED.
  const failedChecks = new Map<string, number>();

  const documentRender: ToolDefinition = {
    name: 'document_render',
    description:
      'Writes a formatted document (resume, cover letter, memo, brief) from structured blocks as a DOCX and a text-based PDF in Drive, and returns both links. ' +
      'You choose the words and the structure; the theme sets fonts, sizes and colours, so never put formatting in the text (only **bold**). ' +
      'Checked against the owner sources like any owner text. The PDF is checked before anything is written: a resume must be exactly 2 pages, ' +
      'a cover letter 1, and its text must read in block order.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: documentSchema,
    isAvailable: deps.isAvailable,
    ownerText: { kind: 'document', field: 'blocks', text: documentOwnerText },
    writesResource: (_params: DocumentSpec, result: any) => result?.fileId,
    execute: async (params: DocumentSpec, context) => {
      const problems = validateBlocks(params.blocks);
      if (problems.length) throw new Error(`[Document Refusal] Nothing was written. ${problems.join(' ')}`);
      const folder = folderPath(params.folder);
      const root = await deps.ownerFolderId();
      if (!root) throw new Error("The owner's folder is not known (the config Doc is not linked), so the document has nowhere to go.");

      const expectedOrder = readingOrder(params.blocks);
      const baseTheme = THEMES[params.theme ?? 'executive-editorial'];
      let docx = await renderDocx(params, baseTheme);
      let pdf: Buffer | undefined;
      let pages: number | undefined;
      let autoFitPreset: string | undefined;
      let visual = 'not run: no PDF renderer here';

      if (deps.pdf) {
        pdf = await deps.pdf.convert(docx);
        let checked = await pdfProblems(deps.pdf, pdf, params.kind, expectedOrder);
        pages = checked.pages;

        // Deterministic micro-typesetting loop: if only the page count missed (e.g. 2.05 pages -> 3, or 1.85 pages -> 1)
        // while reading order is valid, try subtle elastic theme presets before bouncing back to the model.
        const rule = PAGE_RULES[params.kind];
        const initialPageIssues = pageProblems(params.kind, checked.pages);
        const hasReadingOrderIssue = checked.problems.length > initialPageIssues.length;
        if (rule && initialPageIssues.length > 0 && !hasReadingOrderIssue) {
          const direction =
            (rule.exact !== undefined && checked.pages < rule.exact) ? 'looser' : 'tighter';
          for (const preset of getAutoFitPresets(baseTheme, direction)) {
            const candidateDocx = await renderDocx(params, preset.theme);
            const candidatePdf = await deps.pdf.convert(candidateDocx);
            const candidateChecked = await pdfProblems(deps.pdf, candidatePdf, params.kind, expectedOrder);
            if (candidateChecked.problems.length === 0) {
              docx = candidateDocx;
              pdf = candidatePdf;
              checked = candidateChecked;
              pages = candidateChecked.pages;
              autoFitPreset = preset.id;
              break;
            }
          }
        }

        // The visual check runs only on a PDF that passed the structural checks. A failed model call does not
        // stop the write (the structural checks are the gate); the result says the check did not run.
        if (!checked.problems.length && deps.visualCheck) {
          try {
            const found = await deps.visualCheck(await deps.pdf.pageImages(pdf), params.kind);
            checked.problems.push(...found.map(p => `Layout: ${p}`));
            visual = found.length ? 'failed' : 'passed';
          } catch (err: any) {
            visual = `not run: ${err.message}`;
          }
        } else if (!deps.visualCheck) {
          visual = 'not run: no visual checker configured';
        }
        if (checked.problems.length) {
          recordCheckFailure(failedChecks, context.runId, checked.problems, 'document_render');
        }
      }

      const parentId = await deps.ensureFolder(root, folder);
      const name = params.title.trim();
      const docxFile = await deps.upload(`${name}.docx`, DOCX_MIME, docx, parentId);
      const pdfFile = pdf ? await deps.upload(`${name}.pdf`, PDF_MIME, pdf, parentId) : undefined;
      return {
        fileId: docxFile.id,
        name: docxFile.name,
        webViewLink: docxFile.webViewLink,
        pdfFileId: pdfFile?.id,
        pdfLink: pdfFile?.webViewLink,
        pages,
        visualCheck: visual,
        folder,
        theme: params.theme ?? 'executive-editorial',
        ...(autoFitPreset ? { autoFitPreset } : {}),
        paragraphs: expectedOrder.length,
        ...(pdfFile ? {} : { pdf: 'Not made: the PDF renderer is not installed here. Say so; give only the DOCX link.' })
      };
    },
    verify: async (params: DocumentSpec, result: any) => {
      if (!result?.fileId) return { outcome: 'FAILED_SAFE', details: 'No file ID returned.' };
      try {
        const expectedOrder = readingOrder(params.blocks);
        const docx = await deps.download(result.fileId);
        const problems = compareReadingOrder(expectedOrder, await docxParagraphs(docx));
        if (await docxHasTable(docx)) problems.push('The DOCX contains a table.');
        if (result.pdfFileId && deps.pdf) {
          const checked = await pdfProblems(deps.pdf, await deps.download(result.pdfFileId), params.kind, expectedOrder);
          if (checked.pages !== result.pages) problems.push(`The stored PDF has ${checked.pages} pages, not ${result.pages}.`);
          problems.push(...checked.problems);
        }
        if (problems.length) {
          return { outcome: 'FAILED_SAFE', details: `The stored files do not match the blocks: ${problems.join(' ')}` };
        }
        const pdfNote = result.pdfFileId ? ` PDF (${result.pdfFileId}): ${result.pages} pages, text in block order.` : '';
        return { outcome: 'VERIFIED_SUCCESS', details: `DOCX '${result.name}' (${result.fileId}) read back: ${result.paragraphs} paragraphs in block order.${pdfNote}` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Read-back failed: ${err.message}` };
      }
    }
  };

  const visualDocumentRender: ToolDefinition = {
    name: 'visual_document_render',
    description:
      'Renders a single-page visual executive brief, client pitch sheet, or process infographic (one_pager, pitch_sheet, infographic) ' +
      'using structured visual blocks (banner_header, step_flow, split_grid, status_table, benefit_card, icon_strip, cta_footer) ' +
      'with inline SVG icons, bundled typography, and deterministic 1-page A4 auto-fitting. ' +
      'Passes the same owner-text Claims Bank guard, 1-page PDF check, reading-order check, and multimodal visual layout inspection.',
    effectClass: 'INTERNAL_REVERSIBLE_WRITE',
    schema: visualDocumentSchema,
    isAvailable: deps.isAvailable,
    ownerText: { kind: 'document', text: visualDocumentOwnerText },
    writesResource: (_params: VisualDocumentSpec, result: any) => result?.fileId,
    execute: async (params: VisualDocumentSpec, context) => {
      const problems = validateVisualBlocks(params.blocks);
      if (problems.length) throw new Error(`[Document Refusal] Nothing was written. ${problems.join(' ')}`);
      const folder = folderPath(params.folder);
      const root = await deps.ownerFolderId();
      if (!root) throw new Error("The owner's folder is not known (the config Doc is not linked), so the document has nowhere to go.");

      const expectedOrder = visualReadingOrder(params.blocks);
      const convertToPdf = deps.htmlPdf ?? (deps.pdf ? (html: Buffer) => deps.pdf!.convert(html) : undefined);
      const rendered = await renderHtmlPdf(params, { convertToPdf });

      let pages: number | undefined;
      let visual = 'not run: no PDF renderer here';

      if (deps.pdf && rendered.pdf) {
        const checked = await pdfProblems(deps.pdf, rendered.pdf, params.kind, expectedOrder);
        pages = checked.pages;

        if (!checked.problems.length && deps.visualCheck) {
          try {
            const found = await deps.visualCheck(await deps.pdf.pageImages(rendered.pdf), params.kind);
            checked.problems.push(...found.map(p => `Layout: ${p}`));
            visual = found.length ? 'failed' : 'passed';
          } catch (err: any) {
            visual = `not run: ${err.message}`;
          }
        } else if (!deps.visualCheck) {
          visual = 'not run: no visual checker configured';
        }
        if (checked.problems.length) {
          recordCheckFailure(failedChecks, context.runId, checked.problems, 'visual_document_render');
        }
      }

      const parentId = await deps.ensureFolder(root, folder);
      const name = params.title.trim();
      const htmlFile = await deps.upload(`${name}.html`, HTML_MIME, rendered.html, parentId);
      const pdfFile = rendered.pdf ? await deps.upload(`${name}.pdf`, PDF_MIME, rendered.pdf, parentId) : undefined;
      return {
        fileId: htmlFile.id,
        name: htmlFile.name,
        webViewLink: htmlFile.webViewLink,
        pdfFileId: pdfFile?.id,
        pdfLink: pdfFile?.webViewLink,
        pages,
        visualCheck: visual,
        autoFitScale: rendered.scale,
        folder,
        theme: params.theme ?? 'executive-editorial',
        paragraphs: expectedOrder.length
      };
    },
    verify: async (params: VisualDocumentSpec, result: any) => {
      if (!result?.fileId) return { outcome: 'FAILED_SAFE', details: 'No file ID returned.' };
      try {
        const expectedOrder = visualReadingOrder(params.blocks);
        const storedHtml = await deps.download(result.fileId);
        const problems = compareReadingOrder(expectedOrder, htmlParagraphs(storedHtml.toString('utf8')));
        if (result.pdfFileId && deps.pdf) {
          const checked = await pdfProblems(deps.pdf, await deps.download(result.pdfFileId), params.kind, expectedOrder);
          if (checked.pages !== result.pages) problems.push(`The stored PDF has ${checked.pages} pages, not ${result.pages}.`);
          problems.push(...checked.problems);
        }
        if (problems.length) {
          return { outcome: 'FAILED_SAFE', details: `The stored visual files do not match the blocks: ${problems.join(' ')}` };
        }
        const pdfNote = result.pdfFileId ? ` PDF (${result.pdfFileId}): ${result.pages} page, text in block order.` : '';
        return { outcome: 'VERIFIED_SUCCESS', details: `Visual HTML '${result.name}' (${result.fileId}) read back: ${result.paragraphs} segments in block order.${pdfNote}` };
      } catch (err: any) {
        return { outcome: 'RECONCILIATION_REQUIRED', reconciliationNotes: `Read-back failed: ${err.message}` };
      }
    }
  };

  return [documentRender, visualDocumentRender];
}

