import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Turns a DOCX into a text-based PDF and reads the PDF back. */
export interface PdfEngine {
  convert: (docx: Buffer) => Promise<Buffer>;
  pageCount: (pdf: Buffer) => Promise<number>;
  /** The PDF's text in reading order, as a parser (ATS) extracts it. */
  text: (pdf: Buffer) => Promise<string>;
  /** Each page as a PNG, for the visual check. */
  pageImages: (pdf: Buffer) => Promise<Buffer[]>;
}

const BINARIES = ['soffice', 'pdfinfo', 'pdftotext', 'pdftoppm'];

/** True when headless LibreOffice and poppler are installed (the VPS or local dev); checks both bare and .exe names. */
export function pdfToolsInstalled(envPath = process.env.PATH ?? '', pathDelimiter = delimiter): boolean {
  const searchPath = envPath ? envPath.split(pathDelimiter) : ['/usr/bin', '/usr/local/bin'];
  return BINARIES.every(b =>
    searchPath.some(dir => dir && (existsSync(join(dir, b)) || existsSync(join(dir, `${b}.exe`))))
  );
}

async function inTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ellie-doc-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * LibreOffice headless for the conversion, poppler for the read-back. Each conversion gets its own
 * LibreOffice profile, so concurrent runs never share (and lock) one. The fonts are embedded in the DOCX,
 * and LibreOffice uses them, so nothing is installed system-wide.
 */
export const libreOfficeEngine: PdfEngine = {
  convert: doc => inTempDir(async dir => {
    const head = doc.subarray(0, 64).toString('utf8').trimStart();
    const isHtml = head.startsWith('<!DOCTYPE html') || head.startsWith('<html');
    const filename = isHtml ? 'document.html' : 'document.docx';
    await writeFile(join(dir, filename), doc);
    await run('soffice', [
      `-env:UserInstallation=file://${dir}/profile`,
      '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, join(dir, filename)
    ], { timeout: 90_000 });
    return readFile(join(dir, 'document.pdf'));
  }),
  pageCount: pdf => inTempDir(async dir => {
    if (!pdf || pdf.length === 0) throw new Error('PDF buffer is empty');
    await writeFile(join(dir, 'document.pdf'), pdf);
    try {
      const { stdout } = await run('pdfinfo', [join(dir, 'document.pdf')], { timeout: 30_000 });
      const pages = /^Pages:\s+(\d+)/m.exec(stdout);
      if (!pages) throw new Error('pdfinfo did not report a page count.');
      return parseInt(pages[1], 10);
    } catch (err: any) {
      throw new Error(`pdfinfo failed on generated PDF (${pdf.length} bytes): ${err.message}`);
    }
  }),
  text: pdf => inTempDir(async dir => {
    if (!pdf || pdf.length === 0) throw new Error('PDF buffer is empty');
    await writeFile(join(dir, 'document.pdf'), pdf);
    try {
      const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', join(dir, 'document.pdf'), '-'], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    } catch (err: any) {
      throw new Error(`pdftotext failed on generated PDF (${pdf.length} bytes): ${err.message}`);
    }
  }),
  pageImages: pdf => inTempDir(async dir => {
    await writeFile(join(dir, 'document.pdf'), pdf);
    // 80 dpi: enough to see layout, small enough for one model call (about 650 x 920 px per A4 page).
    await run('pdftoppm', ['-r', '80', '-png', join(dir, 'document.pdf'), join(dir, 'page')], { timeout: 60_000 });
    const files = (await readdir(dir)).filter(f => /^page-\d+\.png$/.test(f))
      .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
    return Promise.all(files.map(f => readFile(join(dir, f))));
  })
};

/** Page rules by document kind (the owner's framework: a resume is exactly two pages; a cover letter fits one; visual one-pagers are one). */
export const PAGE_RULES: Partial<Record<string, { exact?: number; max?: number }>> = {
  resume: { exact: 2 },
  cover_letter: { max: 1 },
  one_pager: { exact: 1 },
  pitch_sheet: { exact: 1 },
  infographic: { exact: 1 }
};

export function pageProblems(kind: string, pages: number): string[] {
  const rule = PAGE_RULES[kind];
  if (!rule) return [];
  if (rule.exact !== undefined && pages !== rule.exact) {
    return [`The PDF is ${pages} page${pages === 1 ? '' : 's'}; a ${kind.replace('_', ' ')} must be exactly ${rule.exact}. ${pages > rule.exact ? 'Cut or tighten content' : 'Add substance (or the page is mostly empty)'} and render again.`];
  }
  if (rule.max !== undefined && pages > rule.max) {
    return [`The PDF is ${pages} pages; a ${kind.replace('_', ' ')} must fit ${rule.max}. Cut content and render again.`];
  }
  return [];
}

/**
 * Checks that a 2-page resume fills its final page with substantive content.
 * An under-filled last page (<5 lines or <250 characters) reads as an awkward spillover / orphan overflow.
 */
export function lastPageFillProblems(kind: string, pdfText: string): string[] {
  if (kind !== 'resume') return [];
  const pages = pdfText.split(/[\f\x0c]/).map(p => p.trim()).filter(Boolean);
  if (pages.length < 2) return [];

  const lastPage = pages[pages.length - 1];
  const lines = lastPage.split('\n').map(l => l.trim()).filter(Boolean);
  const charCount = lastPage.replace(/\s+/g, ' ').length;

  if (lines.length < 5 || charCount < 250) {
    return [
      `The last page of the resume has only ${lines.length} line(s) (${charCount} characters); ` +
      `a 2-page resume must balance content across both pages (at least about a quarter of the last page). ` +
      `Tighten content to fit 1 page, or expand bullet points/roles to balance both pages, and render again.`
    ];
  }
  return [];
}

// NFKC folds ligatures (ﬁ) the extractor may emit. Whitespace and hyphens are dropped: lines wrap anywhere, and
// extractors (pdftotext, ATS parsers) join a line ending in a hyphen without it ("follow-the-\nsun" -> "follow-thesun").
const normalize = (s: string) => s.normalize('NFKC').replace(/[\s­\-‐‑]+/g, '').toLowerCase();

/**
 * Checks that the extracted PDF text holds every expected paragraph, in order (ATS reading order).
 * Lines wrap, so whitespace is collapsed; themes may set text in capitals, so case is ignored.
 */
export function readingOrderProblems(expected: string[], pdfText: string): string[] {
  const text = normalize(pdfText);
  let cursor = 0;
  let previous = '(start)';
  for (const line of expected) {
    const needle = normalize(line);
    if (!needle) continue;
    const at = text.indexOf(needle, cursor);
    if (at === -1) {
      const elsewhere = text.indexOf(needle) !== -1;
      return [elsewhere
        ? `In the PDF, "${line.slice(0, 80)}" reads before "${previous.slice(0, 80)}" instead of after it.`
        : `The PDF text does not contain "${line.slice(0, 80)}" as one piece (after "${previous.slice(0, 80)}").`];
    }
    cursor = at + needle.length;
    previous = line;
  }
  return [];
}
