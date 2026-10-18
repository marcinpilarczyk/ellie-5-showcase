import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseInline } from './blocks.js';
import { FONTS_DIR } from './render-docx.js';
import {
  NestedCardBlock,
  renderIconSvg,
  VisualBlock,
  VisualDocumentSpec,
  VisualThemeName
} from './visual-blocks.js';

const run = promisify(execFile);

export const HTML_MIME = 'text/html';
/** Exact A4 page height in CSS pixels at 96 DPI (297mm * 96 / 25.4 = 1122.519px). */
export const A4_HEIGHT_PX = 1122.5;
export const TARGET_MIN_FILL_RATIO = 0.92;
export const TARGET_MAX_FILL_RATIO = 1.0;

export interface AutoFitScale {
  scaleSpace: number;
  scaleFont: number;
  cardPaddingPx: number;
  estimatedFillRatio: number;
  fitsSinglePage: boolean;
}

interface VisualPalette {
  pageBg: string;
  cardBg: string;
  tintedCardBg: string;
  border: string;
  accent: string;
  accentSoft: string;
  highlightCardBg: string;
  highlightCardText: string;
  footerBg: string;
  footerText: string;
  ink: string;
  muted: string;
  quoteBar: string;
}

const PALETTES: Record<VisualThemeName, VisualPalette> = {
  'executive-editorial': {
    pageBg: '#FAF8F5',
    cardBg: '#FFFFFF',
    tintedCardBg: '#F3EFEA',
    border: '#E2DCD3',
    accent: '#17324D',
    accentSoft: '#EBF0F5',
    highlightCardBg: '#17324D',
    highlightCardText: '#FFFFFF',
    footerBg: '#172334',
    footerText: '#F8FAFC',
    ink: '#1E242B',
    muted: '#5A6572',
    quoteBar: '#C86D51'
  },
  'warm-editorial': {
    pageBg: '#FBF9F5',
    cardBg: '#FFFFFF',
    tintedCardBg: '#F4EFE6',
    border: '#E5DEC9',
    accent: '#1E2D3D',
    accentSoft: '#EFECE6',
    highlightCardBg: '#1E2D3D',
    highlightCardText: '#FFFFFF',
    footerBg: '#19232E',
    footerText: '#F9F6F0',
    ink: '#22252A',
    muted: '#5F666D',
    quoteBar: '#D97757'
  },
  'slate-modern': {
    pageBg: '#F8FAFC',
    cardBg: '#FFFFFF',
    tintedCardBg: '#F1F5F9',
    border: '#CBD5E1',
    accent: '#0F172A',
    accentSoft: '#E2E8F0',
    highlightCardBg: '#0F172A',
    highlightCardText: '#FFFFFF',
    footerBg: '#0F172A',
    footerText: '#F8FAFC',
    ink: '#0F172A',
    muted: '#475569',
    quoteBar: '#2563EB'
  }
};

let cachedFontCss: string | undefined;

function fontDataUri(filename: string): string {
  const filePath = resolve(FONTS_DIR, filename);
  if (!existsSync(filePath)) return '';
  const b64 = readFileSync(filePath).toString('base64');
  return `data:font/ttf;base64,${b64}`;
}

/** Builds @font-face declarations using the bundled Google Sans Text and Merriweather TTF files. */
export function buildEmbeddedFontCss(): string {
  if (cachedFontCss !== undefined) return cachedFontCss;
  const faces: Array<{ family: string; file: string; weight: number; style: string }> = [
    { family: 'Google Sans Text', file: 'GoogleSansText-Regular.ttf', weight: 400, style: 'normal' },
    { family: 'Google Sans Text', file: 'GoogleSansText-Bold.ttf', weight: 700, style: 'normal' },
    { family: 'Google Sans Text', file: 'GoogleSansText-Italic.ttf', weight: 400, style: 'italic' },
    { family: 'Google Sans Text', file: 'GoogleSansText-BoldItalic.ttf', weight: 700, style: 'italic' },
    { family: 'Merriweather', file: 'Merriweather-Regular.ttf', weight: 400, style: 'normal' },
    { family: 'Merriweather', file: 'Merriweather-Bold.ttf', weight: 700, style: 'normal' }
  ];
  cachedFontCss = faces
    .map(f => {
      const uri = fontDataUri(f.file);
      if (!uri) return '';
      return `@font-face{font-family:'${f.family}';src:url('${uri}') format('truetype');font-weight:${f.weight};font-style:${f.style};font-display:block;}`;
    })
    .filter(Boolean)
    .join('\n');
  return cachedFontCss;
}

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Renders inline **bold** markup to HTML while escaping all raw text. */
export function renderInlineHtml(text: string): string {
  return parseInline(text.trim())
    .map(span => (span.bold ? `<strong>${escapeHtml(span.text)}</strong>` : escapeHtml(span.text)))
    .join('');
}

/** Wraps a reading-order text segment in an element tagged with `data-ro="1"` for deterministic read-back. */
function roTag(tag: string, className: string, text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  return `<${tag} class="${className}" data-ro="1">${renderInlineHtml(trimmed)}</${tag}>`;
}

/**
 * Deterministic 1-page auto-fit solver: tunes `--scale-space`, `--scale-font`, and `--card-padding`
 * so the rendered content fills 92%–100% of a single A4 page (`1122.5px` at 96 DPI) without overflowing.
 */
export function computeAutoFitScale(scrollHeightPx: number, pageHeightPx = A4_HEIGHT_PX): AutoFitScale {
  const safeHeight = Math.max(100, scrollHeightPx);
  const ratio = pageHeightPx / safeHeight;

  // Already within the 92%–100% sweet spot on page 1
  if (safeHeight <= pageHeightPx && safeHeight >= pageHeightPx * TARGET_MIN_FILL_RATIO) {
    return {
      scaleSpace: 1,
      scaleFont: 1,
      cardPaddingPx: 14,
      estimatedFillRatio: Number((safeHeight / pageHeightPx).toFixed(3)),
      fitsSinglePage: true
    };
  }

  // Overflow (> 100% of 1 A4 page): compress spacing first, then card padding, then font size
  if (safeHeight > pageHeightPx) {
    // Up to ~38% overflow can be deterministically absorbed by micro-typesetting
    const fitsSinglePage = safeHeight <= pageHeightPx * 1.38;
    const scaleSpace = Number(Math.max(0.62, Math.min(1, Math.pow(ratio, 1.35))).toFixed(3));
    const scaleFont = Number(Math.max(0.82, Math.min(1, Math.pow(ratio, 0.55))).toFixed(3));
    const cardPaddingPx = Number(Math.max(8, Math.round(14 * Math.pow(ratio, 0.9))));
    const adjustedHeight = safeHeight * (0.45 * scaleSpace + 0.55 * scaleFont);
    return {
      scaleSpace,
      scaleFont,
      cardPaddingPx,
      estimatedFillRatio: Number(Math.min(1, adjustedHeight / pageHeightPx).toFixed(3)),
      fitsSinglePage
    };
  }

  // Underflow (< 92% of 1 A4 page): expand vertical breathing room & card padding toward ~95% fill
  const targetRatio = (pageHeightPx * 0.95) / safeHeight;
  const scaleSpace = Number(Math.min(1.4, Math.max(1, Math.pow(targetRatio, 1.15))).toFixed(3));
  const scaleFont = Number(Math.min(1.06, Math.max(1, Math.pow(targetRatio, 0.25))).toFixed(3));
  const cardPaddingPx = Number(Math.min(20, Math.round(14 * Math.pow(targetRatio, 0.65))));
  const adjustedHeight = Math.min(pageHeightPx * 0.98, safeHeight * (0.5 * scaleSpace + 0.5 * scaleFont));
  return {
    scaleSpace,
    scaleFont,
    cardPaddingPx,
    estimatedFillRatio: Number((adjustedHeight / pageHeightPx).toFixed(3)),
    fitsSinglePage: true
  };
}

/** Deterministic heuristic estimate of unscaled visual block height in CSS pixels at 96 DPI. */
export function estimateVisualHeightPx(blocks: VisualBlock[]): number {
  let height = 44; // top & bottom page padding
  for (const b of blocks ?? []) {
    switch (b.type) {
      case 'banner_header':
        height += 120 + (b.subtitle ? 36 : 0) + (b.quote ? 48 : 0);
        break;
      case 'step_flow':
        height += (b.title ? 28 : 0) + 175;
        break;
      case 'split_grid': {
        const leftRows = (b.left?.rows?.length ?? 0) * 44 + (b.left?.items?.length ?? 0) * 58 + (b.left?.callout ? 88 : 0) + 70;
        const rightRows = (b.right?.rows?.length ?? 0) * 44 + (b.right?.items?.length ?? 0) * 58 + (b.right?.callout ? 88 : 0) + 70;
        height += Math.max(leftRows, rightRows);
        break;
      }
      case 'status_table':
        height += 68 + (b.rows?.length ?? 0) * 42 + (b.callout ? 84 : 0);
        break;
      case 'benefit_card':
        height += 64 + (b.items?.length ?? 0) * 54;
        break;
      case 'icon_strip':
        height += 92 + (b.note ? 28 : 0);
        break;
      case 'cta_footer':
        height += 155 + (b.calloutText ? 54 : 0) + (b.disclaimer ? 22 : 0);
        break;
    }
  }
  return height;
}

function renderNestedCardHtml(card: NestedCardBlock): string {
  if (card.type === 'status_table') {
    const headerIcon = card.icon ? renderIconSvg(card.icon, 'v-card-header-icon') : '';
    const rowsHtml = (card.rows ?? [])
      .map(r => {
        const tone = r.tone ?? 'neutral';
        return `<div class="v-status-row">
          <div class="v-status-row-main">
            ${roTag('div', 'v-status-label', r.label)}
            ${roTag('div', 'v-status-context', r.context)}
          </div>
          <span class="v-badge v-badge--${tone}" data-ro="1">${renderInlineHtml(r.status.trim())}</span>
        </div>`;
      })
      .join('\n');

    const calloutHtml = card.callout
      ? `<div class="v-callout-box">
          ${roTag('div', 'v-callout-title', card.callout.title)}
          ${roTag('div', 'v-callout-text', card.callout.text)}
          ${roTag('div', 'v-callout-meta', card.callout.meta)}
        </div>`
      : '';

    return `<section class="v-card v-status-table">
      <header class="v-card-header">
        <div class="v-card-header-left">
          ${headerIcon}
          <div>
            ${roTag('h3', 'v-card-title', card.title)}
            ${roTag('div', 'v-card-subtitle', card.subtitle)}
          </div>
        </div>
        <div class="v-card-header-right">
          ${roTag('span', 'v-card-date', card.date)}
          ${roTag('span', 'v-card-pill', card.badge)}
        </div>
      </header>
      <div class="v-status-rows">${rowsHtml}</div>
      ${calloutHtml}
    </section>`;
  }

  // benefit_card
  const itemsHtml = (card.items ?? [])
    .map(item => `<div class="v-benefit-item">
      <div class="v-benefit-icon-wrap">${renderIconSvg(item.icon ?? 'check-circle', 'v-benefit-icon')}</div>
      <div class="v-benefit-body">
        ${roTag('div', 'v-benefit-title', item.title)}
        ${roTag('div', 'v-benefit-desc', item.description)}
      </div>
    </div>`)
    .join('\n');

  return `<section class="v-card v-benefit-card">
    <header class="v-card-header">
      <div>
        ${roTag('h3', 'v-card-title', card.title)}
        ${roTag('div', 'v-card-subtitle', card.subtitle)}
      </div>
    </header>
    <div class="v-benefit-list">${itemsHtml}</div>
  </section>`;
}

function renderVisualBlockHtml(b: VisualBlock): string {
  switch (b.type) {
    case 'banner_header': {
      const topRow = (b.kicker || b.meta)
        ? `<div class="v-banner-top">
            ${roTag('span', 'v-kicker', b.kicker)}
            ${roTag('span', 'v-meta', b.meta)}
          </div>`
        : '';
      const quoteHtml = b.quote?.trim()
        ? `<blockquote class="v-pull-quote">${roTag('p', 'v-pull-quote-text', b.quote)}</blockquote>`
        : '';
      return `<header class="v-banner">
        ${topRow}
        ${roTag('h1', 'v-banner-title', b.title)}
        ${roTag('p', 'v-banner-subtitle', b.subtitle)}
        ${quoteHtml}
      </header>`;
    }
    case 'step_flow': {
      const steps = b.steps ?? [];
      const cardsHtml = steps
        .map((s, idx) => {
          const num = s.number?.trim() || String(idx + 1);
          const highlightClass = s.highlight ? ' v-step-card--highlight' : '';
          const card = `<div class="v-step-card${highlightClass}">
            <div class="v-step-top">
              <span class="v-step-num">${escapeHtml(num)}</span>
              <span class="v-step-icon-wrap">${renderIconSvg(s.icon ?? 'sparkles', 'v-step-icon')}</span>
            </div>
            ${roTag('h3', 'v-step-title', s.title)}
            ${roTag('p', 'v-step-desc', s.description)}
          </div>`;
          const arrow = idx < steps.length - 1
            ? `<div class="v-step-arrow" aria-hidden="true">${renderIconSvg('arrow-right', 'v-arrow-svg')}</div>`
            : '';
          return card + arrow;
        })
        .join('\n');
      return `<section class="v-step-section">
        ${roTag('h2', 'v-section-heading', b.title)}
        <div class="v-step-flow">${cardsHtml}</div>
      </section>`;
    }
    case 'split_grid': {
      const ratio = b.ratio ?? '55-45';
      return `<section class="v-split-grid v-split-grid--${ratio}">
        <div class="v-split-col">${b.left ? renderNestedCardHtml(b.left) : ''}</div>
        <div class="v-split-col">${b.right ? renderNestedCardHtml(b.right) : ''}</div>
      </section>`;
    }
    case 'status_table':
      return renderNestedCardHtml({
        type: 'status_table',
        title: b.title ?? '',
        icon: b.icon,
        date: b.date,
        badge: b.badge,
        rows: b.rows,
        callout: b.callout
      });
    case 'benefit_card':
      return renderNestedCardHtml({
        type: 'benefit_card',
        title: b.title ?? '',
        subtitle: b.subtitle,
        items: b.items
      });
    case 'icon_strip': {
      const colsHtml = (b.columns ?? [])
        .map(col => `<div class="v-strip-col">
          <div class="v-strip-icon-wrap">${renderIconSvg(col.icon ?? 'shield', 'v-strip-icon')}</div>
          <div class="v-strip-copy">
            ${roTag('div', 'v-strip-col-title', col.title)}
            ${roTag('div', 'v-strip-col-text', col.text)}
          </div>
        </div>`)
        .join('\n');
      return `<section class="v-icon-strip">
        ${roTag('h3', 'v-strip-heading', b.title)}
        <div class="v-strip-grid">${colsHtml}</div>
        ${roTag('div', 'v-strip-note', b.note)}
      </section>`;
    }
    case 'cta_footer': {
      const topMeta = (b.kicker || b.author)
        ? `<div class="v-footer-top">
            ${roTag('span', 'v-footer-kicker', b.kicker)}
            ${roTag('span', 'v-footer-author', b.author)}
          </div>`
        : '';
      const callout = (b.calloutTitle || b.calloutText)
        ? `<div class="v-footer-callout">
            ${roTag('div', 'v-footer-callout-title', b.calloutTitle)}
            ${roTag('div', 'v-footer-callout-text', b.calloutText)}
          </div>`
        : '';
      return `<footer class="v-cta-footer">
        ${topMeta}
        <div class="v-footer-main">
          ${roTag('p', 'v-footer-pitch', b.pitch)}
          ${callout}
        </div>
        ${roTag('div', 'v-footer-disclaimer', b.disclaimer)}
      </footer>`;
    }
  }
}

export interface RenderVisualHtmlOptions {
  embedFonts?: boolean;
  scale?: AutoFitScale;
}

/**
 * Renders a VisualDocumentSpec into a self-contained HTML5 document with CSS Grid/Flexbox layout,
 * inline Lucide/Feather SVGs, bundled fonts, and deterministic 1-page A4 auto-fit script.
 */
export function renderVisualHtml(spec: VisualDocumentSpec, options?: RenderVisualHtmlOptions): string {
  const themeName: VisualThemeName = spec.theme ?? 'executive-editorial';
  const palette = PALETTES[themeName] ?? PALETTES['executive-editorial'];
  const estimatedPx = estimateVisualHeightPx(spec.blocks);
  const scale = options?.scale ?? computeAutoFitScale(estimatedPx, A4_HEIGHT_PX);
  const fontCss = options?.embedFonts === false ? '' : buildEmbeddedFontCss();
  const blocksHtml = spec.blocks.map(renderVisualBlockHtml).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(spec.title)}</title>
<style>
${fontCss}
@page {
  size: A4 portrait;
  margin: 0;
}
:root {
  --scale-space: ${scale.scaleSpace};
  --scale-font: ${scale.scaleFont};
  --card-padding: ${scale.cardPaddingPx}px;
  --page-bg: ${palette.pageBg};
  --card-bg: ${palette.cardBg};
  --tinted-bg: ${palette.tintedCardBg};
  --border: ${palette.border};
  --accent: ${palette.accent};
  --accent-soft: ${palette.accentSoft};
  --highlight-bg: ${palette.highlightCardBg};
  --highlight-text: ${palette.highlightCardText};
  --footer-bg: ${palette.footerBg};
  --footer-text: ${palette.footerText};
  --ink: ${palette.ink};
  --muted: ${palette.muted};
  --quote-bar: ${palette.quoteBar};
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
html, body {
  width: 210mm;
  height: 297mm;
  max-height: 297mm;
  background: var(--page-bg);
  color: var(--ink);
  font-family: 'Google Sans Text', -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: calc(9.5pt * var(--scale-font));
  line-height: 1.38;
  overflow: hidden;
}
.v-page {
  width: 210mm;
  height: 297mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: calc(18px * var(--scale-space)) 24px 0 24px;
  gap: calc(12px * var(--scale-space));
}
.v-page-body {
  display: flex;
  flex-direction: column;
  gap: calc(12px * var(--scale-space));
  flex: 1 1 auto;
}
.v-banner {
  border-bottom: 1px solid var(--border);
  padding-bottom: calc(10px * var(--scale-space));
}
.v-banner-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: calc(6px * var(--scale-space));
}
.v-kicker {
  font-size: calc(7.5pt * var(--scale-font));
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--quote-bar);
}
.v-meta {
  font-size: calc(8pt * var(--scale-font));
  color: var(--muted);
}
.v-banner-title {
  font-family: 'Merriweather', Georgia, serif;
  font-size: calc(18pt * var(--scale-font));
  font-weight: 700;
  color: var(--accent);
  line-height: 1.2;
  margin-bottom: calc(6px * var(--scale-space));
}
.v-banner-subtitle {
  font-size: calc(9.5pt * var(--scale-font));
  color: var(--muted);
  margin-bottom: calc(6px * var(--scale-space));
}
.v-pull-quote {
  border-left: 3px solid var(--quote-bar);
  padding-left: 10px;
  margin-top: calc(6px * var(--scale-space));
  font-style: italic;
  color: var(--ink);
  font-size: calc(9pt * var(--scale-font));
}
.v-section-heading {
  font-size: calc(8pt * var(--scale-font));
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-bottom: calc(6px * var(--scale-space));
}
.v-step-flow {
  display: flex;
  align-items: stretch;
  gap: 6px;
}
.v-step-card {
  flex: 1 1 0;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: var(--card-padding);
  display: flex;
  flex-direction: column;
  gap: calc(5px * var(--scale-space));
}
.v-step-card--highlight {
  background: var(--highlight-bg);
  color: var(--highlight-text);
  border-color: var(--highlight-bg);
}
.v-step-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.v-step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 700;
  font-size: calc(7.5pt * var(--scale-font));
}
.v-step-card--highlight .v-step-num {
  background: rgba(255,255,255,0.2);
  color: #FFFFFF;
}
.v-step-icon, .v-card-header-icon, .v-benefit-icon, .v-strip-icon {
  width: 16px;
  height: 16px;
}
.v-step-title {
  font-size: calc(9.5pt * var(--scale-font));
  font-weight: 700;
}
.v-step-desc {
  font-size: calc(8.2pt * var(--scale-font));
  color: var(--muted);
}
.v-step-card--highlight .v-step-desc {
  color: rgba(255,255,255,0.88);
}
.v-step-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  width: 14px;
  flex-shrink: 0;
}
.v-arrow-svg {
  width: 14px;
  height: 14px;
}
.v-split-grid {
  display: grid;
  gap: 12px;
  align-items: stretch;
}
.v-split-grid--50-50 { grid-template-columns: 1fr 1fr; }
.v-split-grid--55-45 { grid-template-columns: 1.22fr 1fr; }
.v-split-grid--60-40 { grid-template-columns: 1.5fr 1fr; }
.v-split-grid--40-60 { grid-template-columns: 1fr 1.5fr; }
.v-card {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: var(--card-padding);
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--scale-space));
}
.v-benefit-card {
  background: var(--tinted-bg);
}
.v-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  border-bottom: 1px solid var(--border);
  padding-bottom: calc(6px * var(--scale-space));
}
.v-card-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}
.v-card-title {
  font-size: calc(10pt * var(--scale-font));
  font-weight: 700;
  color: var(--accent);
}
.v-card-subtitle, .v-card-date {
  font-size: calc(7.8pt * var(--scale-font));
  color: var(--muted);
}
.v-card-pill {
  font-size: calc(7.5pt * var(--scale-font));
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 2px 7px;
  border-radius: 999px;
}
.v-status-rows {
  display: flex;
  flex-direction: column;
  gap: calc(5px * var(--scale-space));
}
.v-status-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: calc(4px * var(--scale-space)) 0;
  border-bottom: 1px dashed var(--border);
}
.v-status-label {
  font-weight: 700;
  font-size: calc(8.8pt * var(--scale-font));
}
.v-status-context {
  font-size: calc(7.8pt * var(--scale-font));
  color: var(--muted);
}
.v-badge {
  font-size: calc(7.5pt * var(--scale-font));
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.v-badge--success { background: #DCFCE7; color: #166534; }
.v-badge--warning { background: #FEF3C7; color: #92400E; }
.v-badge--danger { background: #FEE2E2; color: #991B1B; }
.v-badge--info { background: #DBEAFE; color: #1E40AF; }
.v-badge--neutral { background: #F1F5F9; color: #334155; }
.v-callout-box {
  margin-top: auto;
  background: var(--tinted-bg);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  padding: calc(7px * var(--scale-space)) 10px;
  font-size: calc(8pt * var(--scale-font));
}
.v-callout-title {
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 2px;
}
.v-callout-meta {
  font-size: calc(7.2pt * var(--scale-font));
  color: var(--muted);
  margin-top: 3px;
}
.v-benefit-list {
  display: flex;
  flex-direction: column;
  gap: calc(8px * var(--scale-space));
}
.v-benefit-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.v-benefit-icon-wrap {
  color: var(--quote-bar);
  margin-top: 2px;
}
.v-benefit-title {
  font-weight: 700;
  font-size: calc(8.8pt * var(--scale-font));
}
.v-benefit-desc {
  font-size: calc(8pt * var(--scale-font));
  color: var(--muted);
}
.v-icon-strip {
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: var(--card-padding);
}
.v-strip-heading {
  font-size: calc(8.5pt * var(--scale-font));
  font-weight: 700;
  color: var(--accent);
  margin-bottom: calc(6px * var(--scale-space));
}
.v-strip-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.v-strip-col {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: calc(8pt * var(--scale-font));
}
.v-strip-col-title {
  font-weight: 700;
}
.v-strip-note {
  margin-top: calc(6px * var(--scale-space));
  padding-top: calc(5px * var(--scale-space));
  border-top: 1px solid var(--border);
  font-size: calc(7.5pt * var(--scale-font));
  color: var(--muted);
}
.v-cta-footer {
  margin: 0 -24px;
  padding: calc(14px * var(--scale-space)) 24px;
  background: var(--footer-bg);
  color: var(--footer-text);
  display: flex;
  flex-direction: column;
  gap: calc(6px * var(--scale-space));
}
.v-footer-top {
  display: flex;
  justify-content: space-between;
  font-size: calc(7.5pt * var(--scale-font));
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgba(255,255,255,0.75);
}
.v-footer-main {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 14px;
  align-items: center;
}
.v-footer-pitch {
  font-size: calc(8.5pt * var(--scale-font));
  line-height: 1.4;
}
.v-footer-callout {
  border: 1px solid rgba(255,255,255,0.28);
  border-radius: 6px;
  padding: calc(7px * var(--scale-space)) 10px;
  background: rgba(255,255,255,0.06);
  font-size: calc(8pt * var(--scale-font));
}
.v-footer-callout-title {
  font-weight: 700;
  margin-bottom: 2px;
}
.v-footer-disclaimer {
  font-size: calc(7pt * var(--scale-font));
  color: rgba(255,255,255,0.6);
}
</style>
</head>
<body>
<main class="v-page" id="ellie-visual-page">
  <div class="v-page-body">
    ${blocksHtml}
  </div>
</main>
<script id="ellie-autofit">
(function() {
  var TARGET_PX = 1122.5;
  var MIN_PX = TARGET_PX * 0.92;
  var root = document.documentElement;
  var page = document.getElementById('ellie-visual-page');
  if (!page) return;
  for (var step = 0; step < 8; step++) {
    var h = page.scrollHeight || root.scrollHeight;
    if (h > TARGET_PX) {
      var r = TARGET_PX / h;
      var curSpace = parseFloat(getComputedStyle(root).getPropertyValue('--scale-space')) || 1;
      var curFont = parseFloat(getComputedStyle(root).getPropertyValue('--scale-font')) || 1;
      var curPad = parseFloat(getComputedStyle(root).getPropertyValue('--card-padding')) || 14;
      root.style.setProperty('--scale-space', String(Math.max(0.62, +(curSpace * Math.pow(r, 0.85)).toFixed(3))));
      root.style.setProperty('--scale-font', String(Math.max(0.82, +(curFont * Math.pow(r, 0.45)).toFixed(3))));
      root.style.setProperty('--card-padding', Math.max(8, Math.round(curPad * Math.pow(r, 0.6))) + 'px');
    } else if (h < MIN_PX) {
      var grow = (TARGET_PX * 0.95) / Math.max(100, h);
      var sSpace = parseFloat(getComputedStyle(root).getPropertyValue('--scale-space')) || 1;
      var sPad = parseFloat(getComputedStyle(root).getPropertyValue('--card-padding')) || 14;
      root.style.setProperty('--scale-space', String(Math.min(1.4, +(sSpace * Math.pow(grow, 0.6)).toFixed(3))));
      root.style.setProperty('--card-padding', Math.min(20, Math.round(sPad * Math.pow(grow, 0.4))) + 'px');
    } else {
      break;
    }
  }
})();
</script>
</body>
</html>`;
}

/** Extracts the reading-order text items (`data-ro="1"`) from a rendered visual HTML document. */
export function htmlParagraphs(html: string): string[] {
  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  const out: string[] = [];
  const re = /<([a-z0-9]+)[^>]*\bdata-ro="1"[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cleaned = decode(m[2]);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

const BROWSER_CANDIDATES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'msedge', 'chrome'];

/** Finds an installed headless Chromium/Chrome/Edge binary, if any. */
export function findHeadlessBrowser(envPath = process.env.PATH ?? '', pathDelimiter = delimiter): string | undefined {
  const dirs = envPath.split(pathDelimiter).concat([
    '/usr/bin',
    '/usr/local/bin',
    'C:\\Program Files\\Google\\Chrome\\Application',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application'
  ]);
  for (const bin of BROWSER_CANDIDATES) {
    for (const dir of dirs) {
      if (!dir) continue;
      const bare = join(dir, bin);
      if (existsSync(bare)) return bare;
      const exe = join(dir, `${bin}.exe`);
      if (existsSync(exe)) return exe;
    }
  }
  return undefined;
}

/** Renders an HTML string to a single-page A4 PDF using headless Chromium/Chrome/Edge. */
export async function renderHtmlToPdfWithBrowser(html: string, browserBin?: string): Promise<Buffer> {
  const bin = browserBin ?? findHeadlessBrowser();
  if (!bin) throw new Error('No headless browser binary found for HTML-to-PDF conversion.');
  const dir = await mkdtemp(join(tmpdir(), 'ellie-vdoc-'));
  try {
    const htmlPath = join(dir, 'document.html');
    const pdfPath = join(dir, 'document.pdf');
    await writeFile(htmlPath, html, 'utf8');
    const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}`;
    await run(bin, [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      fileUrl
    ], { timeout: 60_000 });
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RenderedVisualDocument {
  html: Buffer;
  scale: AutoFitScale;
  pdf?: Buffer;
}

/**
 * Renders a VisualDocumentSpec to HTML (with deterministic 1-page auto-fit CSS) and optionally to PDF via headless browser.
 */
export async function renderHtmlPdf(
  spec: VisualDocumentSpec,
  options?: { embedFonts?: boolean; convertToPdf?: (html: Buffer, spec: VisualDocumentSpec) => Promise<Buffer> }
): Promise<RenderedVisualDocument> {
  const estimatedPx = estimateVisualHeightPx(spec.blocks);
  const scale = computeAutoFitScale(estimatedPx, A4_HEIGHT_PX);
  const htmlString = renderVisualHtml(spec, { embedFonts: options?.embedFonts, scale });
  const html = Buffer.from(htmlString, 'utf8');
  let pdf: Buffer | undefined;
  if (options?.convertToPdf) {
    pdf = await options.convertToPdf(html, spec);
  } else {
    const bin = findHeadlessBrowser();
    if (bin) {
      pdf = await renderHtmlToPdfWithBrowser(htmlString, bin);
    }
  }
  return { html, scale, pdf };
}
