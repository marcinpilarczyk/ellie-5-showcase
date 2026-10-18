import { z } from 'zod';
import { plain } from './blocks.js';

export const VISUAL_DOCUMENT_KINDS = ['one_pager', 'pitch_sheet', 'infographic'] as const;
export const VISUAL_THEME_NAMES = ['executive-editorial', 'warm-editorial', 'slate-modern'] as const;
export const VISUAL_BLOCK_TYPES = [
  'banner_header',
  'step_flow',
  'split_grid',
  'status_table',
  'benefit_card',
  'icon_strip',
  'cta_footer'
] as const;

export const BADGE_TONES = ['success', 'warning', 'danger', 'info', 'neutral'] as const;
export const SPLIT_RATIOS = ['50-50', '55-45', '60-40', '40-60'] as const;
export const ICON_NAMES = [
  'database', 'list', 'flag', 'check-circle', 'phone', 'mail', 'calendar',
  'user-check', 'lock', 'sparkles', 'arrow-right', 'alert-circle',
  'shield', 'clock', 'file-text', 'trending-up', 'users', 'zap',
  'search', 'send', 'globe', 'layers', 'check', 'info'
] as const;

export type VisualDocumentKind = typeof VISUAL_DOCUMENT_KINDS[number];
export type VisualThemeName = typeof VISUAL_THEME_NAMES[number];
export type VisualBlockType = typeof VISUAL_BLOCK_TYPES[number];
export type BadgeTone = typeof BADGE_TONES[number];
export type SplitRatio = typeof SPLIT_RATIOS[number];
export type IconName = typeof ICON_NAMES[number];

export function isVisualDocumentKind(kind: string): kind is VisualDocumentKind {
  return (VISUAL_DOCUMENT_KINDS as readonly string[]).includes(kind);
}

/** Curated inline Feather/Lucide 24x24 stroke SVG paths. */
export const ICON_PATHS: Record<IconName, string> = {
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>',
  'list': '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  'flag': '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'phone': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  'mail': '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  'calendar': '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  'user-check': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
  'lock': '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'sparkles': '<path d="m12 3-1.91 5.81a2 2 0 0 1-1.28 1.28L3 12l5.81 1.91a2 2 0 0 1 1.28 1.28L12 21l1.91-5.81a2 2 0 0 1 1.28-1.28L21 12l-5.81-1.91a2 2 0 0 1-1.28-1.28L12 3Z"/>',
  'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  'clock': '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  'users': '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'zap': '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'search': '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'send': '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  'globe': '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  'layers': '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  'check': '<polyline points="20 6 9 17 4 12"/>',
  'info': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
};

/** Renders an inline 24x24 Lucide/Feather SVG icon by name (defaults to 'check-circle' if unknown). */
export function renderIconSvg(name?: string, className = 'v-icon'): string {
  const key = (name?.trim().toLowerCase() ?? 'check-circle') as IconName;
  const inner = ICON_PATHS[key] ?? ICON_PATHS['check-circle'];
  return `<svg class="${className}" data-icon="${key in ICON_PATHS ? key : 'check-circle'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export const statusRowSchema = z.object({
  label: z.string().describe('Primary row label (e.g. client or item name)'),
  context: z.string().optional().describe('Secondary context text (e.g. "Follow-up due · Last call 3w ago")'),
  status: z.string().describe('Badge text (e.g. "Ready to send", "Call today", "Needs review")'),
  tone: z.enum(BADGE_TONES).optional().describe('Semantic badge colour: success | warning | danger | info | neutral')
});

export const calloutBoxSchema = z.object({
  title: z.string().optional().describe('Optional callout label (e.g. "Draft ready for review")'),
  text: z.string().describe('Callout body text (e.g. sample message draft)'),
  meta: z.string().optional().describe('Optional footer/status line inside the callout')
});

export const benefitItemSchema = z.object({
  icon: z.string().optional().describe('Icon name (e.g. check-circle, clock, sparkles, user-check)'),
  title: z.string().describe('Item heading'),
  description: z.string().describe('Item explanation')
});

export const nestedCardSchema = z.object({
  type: z.enum(['status_table', 'benefit_card']).describe('Card kind inside split_grid'),
  icon: z.string().optional().describe('Header icon name'),
  title: z.string().describe('Card header title'),
  subtitle: z.string().optional().describe('Optional card subtitle'),
  date: z.string().optional().describe('status_table: optional header date/meta label'),
  badge: z.string().optional().describe('status_table: optional header pill badge (e.g. "5 priority items")'),
  rows: z.array(statusRowSchema).optional().describe('status_table: status rows'),
  callout: calloutBoxSchema.optional().describe('status_table: optional nested callout box at the bottom of the card'),
  items: z.array(benefitItemSchema).optional().describe('benefit_card: icon-prefixed benefit items')
});

export type NestedCardBlock = z.infer<typeof nestedCardSchema>;

export const stepItemSchema = z.object({
  number: z.string().optional().describe('Step badge label (e.g. "1", "2", "01")'),
  icon: z.string().optional().describe('SVG icon name (e.g. database, list, flag, check-circle)'),
  title: z.string().describe('Step card title'),
  description: z.string().describe('Step card body text'),
  highlight: z.boolean().optional().describe('True for the final/payoff step to render as a solid dark accent card')
});

export const iconStripColumnSchema = z.object({
  icon: z.string().optional().describe('SVG icon name (e.g. user-check, lock, shield)'),
  title: z.string().optional().describe('Optional short column label'),
  text: z.string().describe('Column text')
});

/**
 * Flat visual block schema (no unions so Gemini function declarations serialize every property cleanly).
 */
export const visualBlockSchema = z.object({
  type: z.enum(VISUAL_BLOCK_TYPES).describe(
    'banner_header: top kicker, meta, title, subtitle, optional pull-quote. ' +
    'step_flow: 3-5 horizontal cards connected by arrows. ' +
    'split_grid: 2-column grid holding left & right cards (status_table or benefit_card). ' +
    'status_table: standalone status badge table with optional callout box. ' +
    'benefit_card: standalone tinted card with icon-prefixed items. ' +
    'icon_strip: full-width bordered card with 2-4 horizontal icon+text columns and optional bottom note. ' +
    'cta_footer: full-bleed dark accent footer with kicker, author, pitch, callout box, and disclaimer.'
  ),
  // banner_header / shared
  kicker: z.string().optional().describe('banner_header or cta_footer: uppercase kicker label'),
  meta: z.string().optional().describe('banner_header: right-aligned author/date metadata'),
  title: z.string().optional().describe('Block title or section heading'),
  subtitle: z.string().optional().describe('banner_header or benefit_card: subtitle text'),
  quote: z.string().optional().describe('banner_header: optional pull-quote with vertical accent bar'),
  // step_flow
  steps: z.array(stepItemSchema).optional().describe('step_flow: 3 to 5 horizontal step cards connected by arrows'),
  // split_grid
  ratio: z.enum(SPLIT_RATIOS).optional().describe('split_grid: column width ratio (50-50, 55-45, 60-40, 40-60)'),
  left: nestedCardSchema.optional().describe('split_grid: left column card (status_table or benefit_card)'),
  right: nestedCardSchema.optional().describe('split_grid: right column card (status_table or benefit_card)'),
  // standalone status_table / benefit_card
  icon: z.string().optional().describe('status_table: header icon name'),
  date: z.string().optional().describe('status_table: header date label'),
  badge: z.string().optional().describe('status_table: header count/summary pill badge'),
  rows: z.array(statusRowSchema).optional().describe('status_table: table rows with semantic pill badges'),
  callout: calloutBoxSchema.optional().describe('status_table: optional nested callout box'),
  items: z.array(benefitItemSchema).optional().describe('benefit_card: icon-prefixed items'),
  // icon_strip
  columns: z.array(iconStripColumnSchema).optional().describe('icon_strip: 2 to 4 horizontal icon+text columns'),
  note: z.string().optional().describe('icon_strip: optional bottom assumption or governance note line'),
  // cta_footer
  author: z.string().optional().describe('cta_footer: author/role attribution line'),
  pitch: z.string().optional().describe('cta_footer: main pitch paragraph'),
  calloutTitle: z.string().optional().describe('cta_footer: heading inside the bordered hypothesis/next-step box'),
  calloutText: z.string().optional().describe('cta_footer: body text inside the bordered hypothesis/next-step box'),
  disclaimer: z.string().optional().describe('cta_footer: small source or disclaimer line at the bottom')
});

export type VisualBlock = z.infer<typeof visualBlockSchema>;

export const visualDocumentSchema = z.object({
  kind: z.enum(VISUAL_DOCUMENT_KINDS).describe('Visual document type: one_pager, pitch_sheet, or infographic (always 1 A4 page)'),
  theme: z.enum(VISUAL_THEME_NAMES).optional().default('executive-editorial').describe('Visual colour & typography theme'),
  title: z.string().describe('File name without extension, e.g. "Client Follow-Up Assistant - Pitch Sheet"'),
  folder: z.string().optional().describe('Drive folder path inside the owner\'s folder. Default "Documents".'),
  blocks: z.array(visualBlockSchema).describe('Visual component blocks in top-to-bottom reading order')
});

export type VisualDocumentSpec = z.infer<typeof visualDocumentSchema>;

function validateNestedCard(card: NestedCardBlock | undefined, label: string, problems: string[]): void {
  if (!card) {
    problems.push(`${label} is required.`);
    return;
  }
  if (!card.title?.trim()) problems.push(`${label} (${card.type}) needs title.`);
  if (card.type === 'status_table') {
    if (!card.rows || card.rows.length === 0) problems.push(`${label} (status_table) needs rows.`);
    card.rows?.forEach((r, idx) => {
      if (!r.label?.trim() || !r.status?.trim()) problems.push(`${label} row ${idx + 1} needs label and status.`);
    });
  } else if (card.type === 'benefit_card') {
    if (!card.items || card.items.length === 0) problems.push(`${label} (benefit_card) needs items.`);
    card.items?.forEach((it, idx) => {
      if (!it.title?.trim() || !it.description?.trim()) problems.push(`${label} item ${idx + 1} needs title and description.`);
    });
  }
}

/** Validates visual blocks before rendering; returns an empty array when valid. */
export function validateVisualBlocks(blocks: VisualBlock[]): string[] {
  const problems: string[] = [];
  if (!Array.isArray(blocks) || blocks.length === 0) {
    problems.push('The visual document has no blocks.');
    return problems;
  }
  blocks.forEach((b, i) => {
    const prefix = `Block ${i + 1} (${b.type})`;
    switch (b.type) {
      case 'banner_header':
        if (!b.title?.trim()) problems.push(`${prefix} needs title.`);
        break;
      case 'step_flow':
        if (!b.steps || b.steps.length < 3 || b.steps.length > 5) {
          problems.push(`${prefix} needs between 3 and 5 steps.`);
        } else {
          b.steps.forEach((s, idx) => {
            if (!s.title?.trim() || !s.description?.trim()) {
              problems.push(`${prefix} step ${idx + 1} needs title and description.`);
            }
          });
        }
        break;
      case 'split_grid':
        validateNestedCard(b.left, `${prefix} left card`, problems);
        validateNestedCard(b.right, `${prefix} right card`, problems);
        break;
      case 'status_table':
        validateNestedCard({ type: 'status_table', title: b.title ?? '', icon: b.icon, date: b.date, badge: b.badge, rows: b.rows, callout: b.callout }, prefix, problems);
        break;
      case 'benefit_card':
        validateNestedCard({ type: 'benefit_card', title: b.title ?? '', subtitle: b.subtitle, items: b.items }, prefix, problems);
        break;
      case 'icon_strip':
        if (!b.columns || b.columns.length < 2 || b.columns.length > 4) {
          problems.push(`${prefix} needs between 2 and 4 columns.`);
        } else {
          b.columns.forEach((c, idx) => {
            if (!c.text?.trim()) problems.push(`${prefix} column ${idx + 1} needs text.`);
          });
        }
        break;
      case 'cta_footer':
        if (!b.pitch?.trim()) problems.push(`${prefix} needs pitch.`);
        break;
    }
  });
  return problems;
}

function pushNestedCardReadingOrder(card: NestedCardBlock | undefined, out: string[]): void {
  if (!card) return;
  const push = (s?: string) => {
    const cleaned = plain((s ?? '').trim());
    if (cleaned) out.push(cleaned);
  };
  push(card.title);
  push(card.subtitle);
  push(card.date);
  push(card.badge);
  if (card.type === 'status_table') {
    for (const r of card.rows ?? []) {
      push(r.label);
      push(r.context);
      push(r.status);
    }
    if (card.callout) {
      push(card.callout.title);
      push(card.callout.text);
      push(card.callout.meta);
    }
  } else if (card.type === 'benefit_card') {
    for (const item of card.items ?? []) {
      push(item.title);
      push(item.description);
    }
  }
}

/**
 * Extracts all text segments from visual blocks in strict top-to-bottom, left-to-right reading order.
 * Used by both ClaimsBankGuard (ownerText) and pdftotext reading-order verification.
 */
export function visualReadingOrder(blocks: VisualBlock[]): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    const cleaned = plain((s ?? '').trim());
    if (cleaned) out.push(cleaned);
  };

  for (const b of blocks ?? []) {
    switch (b.type) {
      case 'banner_header':
        push(b.kicker);
        push(b.meta);
        push(b.title);
        push(b.subtitle);
        push(b.quote);
        break;
      case 'step_flow':
        push(b.title);
        for (const s of b.steps ?? []) {
          push(s.title);
          push(s.description);
        }
        break;
      case 'split_grid':
        pushNestedCardReadingOrder(b.left, out);
        pushNestedCardReadingOrder(b.right, out);
        break;
      case 'status_table':
        pushNestedCardReadingOrder({
          type: 'status_table',
          title: b.title ?? '',
          icon: b.icon,
          date: b.date,
          badge: b.badge,
          rows: b.rows,
          callout: b.callout
        }, out);
        break;
      case 'benefit_card':
        pushNestedCardReadingOrder({
          type: 'benefit_card',
          title: b.title ?? '',
          subtitle: b.subtitle,
          items: b.items
        }, out);
        break;
      case 'icon_strip':
        push(b.title);
        for (const col of b.columns ?? []) {
          push(col.title);
          push(col.text);
        }
        push(b.note);
        break;
      case 'cta_footer':
        push(b.kicker);
        push(b.author);
        push(b.pitch);
        push(b.calloutTitle);
        push(b.calloutText);
        push(b.disclaimer);
        break;
    }
  }
  return out;
}
