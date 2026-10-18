import { z } from 'zod';

/**
 * One schema for every rendered document (resume, cover letter, memo, brief). The model chooses words and
 * structure; the theme chooses fonts, sizes, colours and spacing. Inline markup is **bold** only.
 * Block fields are flat (one object, the fields used depend on type) because tool schemas reach the model
 * without unions.
 */
export const DOCUMENT_KINDS = ['resume', 'cover_letter', 'memo', 'brief', 'report'] as const;
export const THEME_NAMES = ['executive-editorial'] as const;
export const BLOCK_TYPES = ['header', 'heading', 'paragraph', 'bullets', 'role', 'keyvalue', 'note'] as const;

export type DocumentKind = typeof DOCUMENT_KINDS[number];
export type ThemeName = typeof THEME_NAMES[number];
export type BlockType = typeof BLOCK_TYPES[number];

export const blockSchema = z.object({
  type: z.enum(BLOCK_TYPES).describe(
    'header: name, headline, contact (top of the page, once). heading: section title in text. paragraph: text. ' +
    'bullets: items. role: title, employer, dates, location, optional context line, bullets. ' +
    'keyvalue: lines of label + text (e.g. skills by area). note: small print in text (e.g. a consent clause).'
  ),
  text: z.string().optional().describe('heading, paragraph, note: the text. **bold** allowed in paragraph.'),
  name: z.string().optional().describe('header: the person\'s full name'),
  headline: z.string().optional().describe('header: one positioning line'),
  contact: z.array(z.string()).optional().describe('header: contact items (location, email, phone, link), each from the owner sources'),
  items: z.array(z.string()).optional().describe('bullets: one string per bullet. **bold** allowed.'),
  title: z.string().optional().describe('role: job title'),
  employer: z.string().optional().describe('role: employer'),
  dates: z.string().optional().describe('role: e.g. "Jan 2025 – Present"'),
  location: z.string().optional().describe('role: location'),
  context: z.string().optional().describe('role: optional one-line description of the employer'),
  bullets: z.array(z.string()).optional().describe('role: achievement bullets. **bold** allowed.'),
  lines: z.array(z.object({
    label: z.string().describe('e.g. "Delivery & governance"'),
    text: z.string()
  })).optional().describe('keyvalue: the lines')
});

export type Block = z.infer<typeof blockSchema>;

export const documentSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS).describe('What the document is'),
  theme: z.enum(THEME_NAMES).optional().default('executive-editorial').describe('Visual theme (fonts, sizes, colours live in the theme)'),
  title: z.string().describe('File name without extension, e.g. "Jane Doe - Contoso Senior PM Resume"'),
  folder: z.string().optional().describe('Drive folder path inside the owner\'s folder, e.g. "Projects/JOB_SEARCH/Resumes". Created if missing. Default "Documents".'),
  blocks: z.union([z.array(blockSchema).min(1), z.string()]).describe('The document blocks, or a draft handle from owner_text_check')
});

export type DocumentSpec = Omit<z.infer<typeof documentSchema>, 'blocks'> & { blocks: Block[] };

/** Separator between the parts of one line (contact items; employer, dates, location). */
export const PART_SEPARATOR = '  |  ';

const REQUIRED: Record<BlockType, (keyof Block)[]> = {
  header: ['name'],
  heading: ['text'],
  paragraph: ['text'],
  bullets: ['items'],
  role: ['title', 'employer'],
  keyvalue: ['lines'],
  note: ['text']
};

/** Problems with the blocks, one line each; empty when the document can be rendered. */
export function validateBlocks(blocks: Block[]): string[] {
  const problems: string[] = [];
  if (blocks.length === 0) problems.push('The document has no blocks.');
  blocks.forEach((b, i) => {
    const req = REQUIRED[b.type] as (keyof Block)[];
    for (const field of req) {
      const v = (b as any)[field];
      if (v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)) {
        problems.push(`Block ${i + 1} (${b.type}) needs ${String(field)}.`);
      }
    }
  });
  const headers = blocks.filter(b => b.type === 'header').length;
  if (headers > 1) problems.push('Only one header block is allowed.');
  if (headers === 1 && blocks[0].type !== 'header') problems.push('The header block must come first.');
  return problems;
}

/** A run of text with its inline emphasis. */
export interface Span { text: string; bold: boolean }

/** Splits **bold** markup into spans. Unpaired markers are kept as text. */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index), bold: false });
    spans.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), bold: false });
  return spans.filter(s => s.text.length > 0);
}

export function plain(text: string): string {
  return parseInline(text).map(s => s.text).join('');
}

/** The employer line of a role: employer, dates and location, as rendered. */
export function roleMetaParts(b: Block): string[] {
  return [b.employer, b.dates, b.location].map(s => s?.trim()).filter((s): s is string => Boolean(s));
}

/**
 * The document's paragraphs in reading order, as plain text, exactly as the renderer writes them
 * (one entry per paragraph). The owner-text guard reads this, and read-back compares against it.
 */
export function readingOrder(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'header':
        out.push((b.name ?? '').trim());
        if (b.headline?.trim()) out.push(b.headline.trim());
        if (b.contact?.length) out.push(b.contact.map(c => c.trim()).filter(Boolean).join(PART_SEPARATOR));
        break;
      case 'heading':
        out.push((b.text ?? '').trim());
        break;
      case 'paragraph':
      case 'note':
        out.push(plain((b.text ?? '').trim()));
        break;
      case 'bullets':
        for (const item of (b.items ?? [])) out.push(plain(item.trim()));
        break;
      case 'role':
        out.push((b.title ?? '').trim());
        out.push(roleMetaParts(b).join(PART_SEPARATOR));
        if (b.context?.trim()) out.push(b.context.trim());
        for (const item of b.bullets ?? []) out.push(plain(item.trim()));
        break;
      case 'keyvalue':
        for (const l of (b.lines ?? [])) out.push(`${l.label.trim()}: ${plain(l.text.trim())}`);
        break;
    }
  }
  return out.filter(s => s.length > 0);
}
