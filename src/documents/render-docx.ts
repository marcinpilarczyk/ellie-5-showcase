import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, LevelFormat, Packer, Paragraph, Tab, TabStopType, TextRun
} from 'docx';
import JSZip from 'jszip';
import { Block, DocumentSpec, PART_SEPARATOR, parseInline, roleMetaParts } from './blocks.js';
import { Theme, TextStyle, ThemeFont, THEMES } from './themes.js';

export const FONTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/fonts');
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const pt = (n: number) => Math.round(n * 20); // twips
const halfPt = (n: number) => Math.round(n * 2);
const mm = (n: number) => Math.round((n * 1440) / 25.4); // twips; A4 is 11906 x 16838

function run(text: string, style: TextStyle, theme: Theme, over: Partial<TextStyle> = {}): TextRun {
  const s = { ...style, ...over };
  return new TextRun({
    text,
    font: theme.fonts[s.font].family,
    size: halfPt(s.sizePt),
    color: s.color,
    bold: s.bold,
    italics: s.italic,
    allCaps: s.allCaps,
    characterSpacing: s.letterSpacingPt ? pt(s.letterSpacingPt) : undefined
  });
}

/** Inline **bold** spans in a body style. */
function inline(text: string, style: TextStyle, theme: Theme): TextRun[] {
  return parseInline(text.trim()).map(s => run(s.text, style, theme, s.bold ? { bold: true } : {}));
}

function lineSpacing(theme: Theme) {
  return { line: Math.round(240 * theme.lineSpacing) };
}

function bulletParagraph(text: string, theme: Theme, keepNext = false): Paragraph {
  return new Paragraph({
    numbering: { reference: 'bullets', level: 0 },
    spacing: { ...lineSpacing(theme), after: pt(theme.bullet.spaceAfterPt) },
    keepLines: true,
    keepNext,
    children: inline(text, theme.body, theme)
  });
}

/**
 * A list's paragraphs. The last two items stay together, so a list never leaves one item alone at the top
 * of a page; with withFirst, the first item stays with what comes before it (a role's title lines).
 */
function bulletList(items: string[], theme: Theme, withFirst = false): Paragraph[] {
  return items.map((item, i) => bulletParagraph(item, theme, i === items.length - 2 || (withFirst && i === 0 && items.length > 1)));
}

function separated(parts: Array<{ text: string; style: TextStyle }>, theme: Theme): TextRun[] {
  const out: TextRun[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(run(PART_SEPARATOR, theme.roleMeta, theme));
    out.push(run(p.text, p.style, theme));
  });
  return out;
}

/** Detects email addresses and URLs in contact items so they render as clickable links. */
export function contactHref(raw: string): string | undefined {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return undefined;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return `mailto:${s}`;
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  if (/^(?:www\.|[a-z0-9-]+\.(?:com|org|net|io|pl|eu|co|uk|de|fr|me|ai|dev|edu|gov))(?:\b|\/)\S*$/i.test(s)) {
    return `https://${s}`;
  }
  return undefined;
}

function contactChildren(items: string[], theme: Theme): Array<TextRun | ExternalHyperlink> {
  const out: Array<TextRun | ExternalHyperlink> = [];
  items.forEach((text, i) => {
    if (i > 0) out.push(run(PART_SEPARATOR, theme.roleMeta, theme));
    const href = contactHref(text);
    const textRun = run(text, theme.contact, theme);
    out.push(href ? new ExternalHyperlink({ link: href, children: [textRun] }) : textRun);
  });
  return out;
}

function rightContentTabStop(theme: Theme) {
  return [{
    type: TabStopType.RIGHT,
    position: mm(theme.page.widthMm - 2 * theme.page.marginSideMm)
  }];
}

function roleMetaChildren(meta: Array<{ text: string; style: TextStyle }>, theme: Theme): TextRun[] {
  if (meta.length <= 1) return separated(meta, theme);
  // Employer on the left, then separator + right-aligned tab + Dates / Location flush-right at the content margin.
  // docxParagraphs maps <w:tab/> to ' ', so '  | ' + <w:tab/> reconstructs PART_SEPARATOR ('  |  ') in reading order.
  return [
    run(meta[0].text, meta[0].style, theme),
    run('  | ', theme.roleMeta, theme),
    new TextRun({ children: [new Tab()] }),
    ...separated(meta.slice(1), theme)
  ];
}

function renderBlock(b: Block, theme: Theme): Paragraph[] {
  const body = { ...lineSpacing(theme), after: pt(theme.body.spaceAfterPt) };
  switch (b.type) {
    case 'header': {
      const out = [new Paragraph({ spacing: { after: pt(2) }, children: [run(b.name!.trim(), theme.personName, theme)] })];
      if (b.headline?.trim()) out.push(new Paragraph({ spacing: { after: pt(1) }, children: [run(b.headline.trim(), theme.headline, theme)] }));
      const contact = (b.contact ?? []).map(c => c.trim()).filter(Boolean);
      if (contact.length) out.push(new Paragraph({ spacing: { after: pt(4) }, children: contactChildren(contact, theme) }));
      return out;
    }
    case 'heading': {
      const h = theme.heading;
      return [new Paragraph({
        keepNext: true,
        spacing: { before: pt(h.spaceBeforePt), after: pt(h.spaceAfterPt) },
        border: { bottom: { style: BorderStyle.SINGLE, size: Math.round(h.rulePt * 8), color: h.ruleColor, space: 2 } },
        children: [run(b.text!.trim(), h, theme)]
      })];
    }
    case 'paragraph':
      return [new Paragraph({ spacing: body, children: inline(b.text!, theme.body, theme) })];
    case 'note':
      return [new Paragraph({ spacing: { before: pt(theme.note.spaceBeforePt) }, children: [run(b.text!.trim(), theme.note, theme)] })];
    case 'bullets':
      return bulletList(b.items!, theme);
    case 'role': {
      const meta = roleMetaParts(b).map((text, i) => ({ text, style: i === 0 ? theme.roleEmployer : theme.roleMeta }));
      const tabStops = rightContentTabStop(theme);
      const out = [
        new Paragraph({ keepNext: true, tabStops, spacing: { before: pt(theme.roleTitle.spaceBeforePt) }, children: [run(b.title!.trim(), theme.roleTitle, theme)] }),
        new Paragraph({ keepNext: true, tabStops, spacing: { after: pt(2) }, children: roleMetaChildren(meta, theme) })
      ];
      if (b.context?.trim()) out.push(new Paragraph({ keepNext: true, spacing: { after: pt(2) }, children: [run(b.context.trim(), theme.roleContext, theme)] }));
      // The first bullet stays with the role lines, so a role never ends a page on its title alone.
      out.push(...bulletList(b.bullets ?? [], theme, true));
      return out;
    }
    case 'keyvalue':
      return b.lines!.map(l => new Paragraph({
        spacing: { ...lineSpacing(theme), after: pt(2) },
        children: [run(`${l.label.trim()}: `, theme.body, theme, { bold: true }), ...inline(l.text, theme.body, theme)]
      }));
    default:
      return [];
  }
}

/** Renders the document with its theme (or a micro-typesetting theme override). Fonts are embedded. */
export async function renderDocx(spec: DocumentSpec, themeOverride?: Theme): Promise<Buffer> {
  const theme = themeOverride ?? THEMES[spec.theme ?? 'executive-editorial'];
  const sans = theme.fonts.sans;
  const doc = new Document({
    title: spec.title,
    creator: 'Ellie',
    styles: { default: { document: { run: { font: sans.family, size: halfPt(theme.body.sizePt), color: theme.body.color } } } },
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: theme.bullet.glyph,
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: { indent: { left: pt(theme.bullet.indentPt), hanging: pt(theme.bullet.hangingPt) } },
            run: { font: sans.family, color: theme.body.color }
          }
        }]
      }]
    },
    // A placeholder so docx writes the font table plumbing (content type, relationships); replaced below.
    fonts: [{ name: sans.family, data: readFileSync(resolve(FONTS_DIR, sans.regular!)) }],
    sections: [{
      properties: {
        page: {
          size: { width: mm(theme.page.widthMm), height: mm(theme.page.heightMm) },
          margin: {
            top: mm(theme.page.marginTopMm),
            bottom: mm(theme.page.marginBottomMm),
            left: mm(theme.page.marginSideMm),
            right: mm(theme.page.marginSideMm)
          }
        }
      },
      children: spec.blocks.flatMap(b => renderBlock(b, theme))
    }]
  });
  return embedFonts(await Packer.toBuffer(doc), [theme.fonts.sans, theme.fonts.serif]);
}

const FACES = [['regular', 'embedRegular'], ['bold', 'embedBold'], ['italic', 'embedItalic'], ['boldItalic', 'embedBoldItalic']] as const;

/** OOXML font obfuscation (ECMA-376): the first 32 bytes XORed with the key's bytes in reverse. */
function obfuscate(font: Buffer, key: string): Buffer {
  const bytes = key.replace(/[{}-]/g, '').match(/../g)!.map(h => parseInt(h, 16)).reverse();
  const out = Buffer.from(font);
  for (let i = 0; i < 32; i++) out[i] ^= bytes[i % 16];
  return out;
}

/** Replaces the font table with one that embeds every face of every theme font (docx embeds Regular only). */
async function embedFonts(docx: Buffer, fonts: ThemeFont[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(docx);
  for (const name of Object.keys(zip.files)) if (name.startsWith('word/fonts/')) zip.remove(name);

  const rels: string[] = [];
  const entries = fonts.map(f => {
    const embeds = FACES.flatMap(([face, tag]) => {
      const file = f[face];
      if (!file) return [];
      const id = `rId${rels.length + 1}`;
      const key = `{${randomUUID().toUpperCase()}}`;
      const target = `fonts/font${rels.length + 1}.odttf`;
      zip.file(`word/${target}`, obfuscate(readFileSync(resolve(FONTS_DIR, file)), key));
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="${target}"/>`);
      return [`<w:${tag} r:id="${id}" w:fontKey="${key}"/>`];
    });
    return `<w:font w:name="${f.family}"><w:charset w:val="00"/><w:family w:val="auto"/><w:pitch w:val="variable"/>${embeds.join('')}</w:font>`;
  });

  zip.file('word/fontTable.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:fonts xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    entries.join('') + '</w:fonts>');
  zip.file('word/_rels/fontTable.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join('') + '</Relationships>');

  // Word keeps embedded fonts on save only with this setting. Schema order: after displayBackgroundShape.
  const settings = await zip.file('word/settings.xml')!.async('string');
  if (!settings.includes('w:embedTrueTypeFonts')) {
    const anchor = settings.includes('<w:displayBackgroundShape/>') ? /(<w:displayBackgroundShape\/>)/ : /(<w:settings[^>]*>)/;
    zip.file('word/settings.xml', settings.replace(anchor, '$1<w:embedTrueTypeFonts/>'));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The text of each paragraph in a DOCX (or visual HTML), in order (w:t runs joined; tabs and breaks as spaces). */
export async function docxParagraphs(docx: Buffer): Promise<string[]> {
  const head = docx.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('<!DOCTYPE html') || head.startsWith('<html')) {
    const { htmlParagraphs } = await import('./render-html-pdf.js');
    return htmlParagraphs(docx.toString('utf8'));
  }
  const zip = await JSZip.loadAsync(docx);
  const xml = await zip.file('word/document.xml')!.async('string');
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const paragraphs: string[] = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const text = (p.match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) ?? [])
      .map(t => t.startsWith('<w:t') && !t.startsWith('<w:tab') ? decode(t.replace(/<[^>]+>/g, '')) : ' ')
      .join('');
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs;
}

/** True when the DOCX contains a table (themes never use tables; ATS parsers misread them). */
export async function docxHasTable(docx: Buffer): Promise<boolean> {
  const zip = await JSZip.loadAsync(docx);
  return (await zip.file('word/document.xml')!.async('string')).includes('<w:tbl>');
}

/**
 * Compares the DOCX paragraphs with the expected reading order. Returns the problems, empty when every
 * expected line is there, in order, and nothing else is.
 */
export function compareReadingOrder(expected: string[], actual: string[]): string[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const a = actual.map(norm);
  const e = expected.map(norm);
  const problems: string[] = [];
  if (a.length !== e.length) problems.push(`Expected ${e.length} paragraphs, found ${a.length}.`);
  for (let i = 0; i < Math.min(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      problems.push(`Paragraph ${i + 1} reads "${a[i].slice(0, 80)}", expected "${e[i].slice(0, 80)}".`);
      break;
    }
  }
  return problems;
}
