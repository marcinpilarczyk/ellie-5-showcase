import { ModelRouter } from '../models/model-router.js';
import { isVisualDocumentKind } from './visual-blocks.js';

/** Looks at the rendered pages and lists layout defects a reader would notice; empty when the pages look right. */
export type VisualCheck = (pages: Buffer[], kind: string) => Promise<string[]>;

const PROMPT = (kind: string, pages: number) => {
  const isVisual = isVisualDocumentKind(kind);
  return `You are checking the layout of a rendered ${kind.replace('_', ' ')} (${pages} page image${pages === 1 ? '' : 's'}, in order).
Report only clear layout defects a reader would notice:
- text cut off, running past the margin, or overlapping other text;
- a section heading, job title or employer line at the bottom of a page with its content starting on the next page;
- a single line of text (one line of a paragraph, or one lone bullet that ends a list) alone at the top of a page; a role or list that continues across pages with two or more lines on each side is normal;
- visibly uneven spacing: one gap between sections or entries much larger or smaller than the others;
- a page other than the last that is mostly empty;${kind === 'resume' ? '\n- a last page with only a few lines on it (less than about a quarter of the page): the resume reads as one page plus overflow.' : ''}${isVisual ? '\n- clipped text inside cards or badges, overlapping boxes, uneven card alignment, or footer overflow past the single page;' : ''}
Do not judge wording, content, colours or fonts${kind === 'resume' || isVisual ? '' : ', and do not report the last page being partly empty'}.
For each defect, name the page and quote the text where it is. If there is no clear defect, return ok true and no problems.`;
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } }
  },
  required: ['ok', 'problems']
};

/** One multimodal Flash call over the page images (low thinking, temperature 0). */
export function createVisualCheck(modelRouter: ModelRouter): VisualCheck {
  return async (pages, kind) => {
    const resp = await modelRouter.generate(
      [{
        role: 'user',
        parts: [
          { text: PROMPT(kind, pages.length) },
          ...pages.map(p => ({ inlineData: { mimeType: 'image/png', data: p.toString('base64') } }))
        ]
      }],
      { tier: 'SENTINEL', temperature: 0, responseSchema: RESPONSE_SCHEMA, mediaResolution: 'MEDIA_RESOLUTION_MEDIUM', source: 'document_visual_check' }
    );
    const parsed = JSON.parse(resp.text || '{}') as { ok?: boolean; problems?: string[] };
    const problems = (parsed.problems ?? []).map(p => String(p).trim()).filter(Boolean);
    return parsed.ok === true && problems.length === 0 ? [] : problems.length ? problems : ['The visual check found a layout problem but did not say which.'];
  };
}
