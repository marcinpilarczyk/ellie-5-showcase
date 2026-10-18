import { z } from 'zod';
import { ToolDefinition } from '../types/tool.js';
import { ClaimsGuard, reviewOwnerText } from '../governance/claims-bank.js';
import { OWNER_NAME } from '../config/owner.js';
import { blockSchema, readingOrder, validateBlocks, Block } from '../documents/blocks.js';

/**
 * Dry run of the checks every draft and document write gets, plus the humanization scanner
 * (the scripts the writing skills describe). The model checks a draft in one call instead of
 * reading skill references, scripts or repo files to imitate the check by hand.
 */
export function createOwnerTextCheckTool(guard: ClaimsGuard): ToolDefinition {
  return {
    name: 'owner_text_check',
    description: `Checks a draft in ${OWNER_NAME}'s name before you write it: the same checks the write runs (Claims Bank, contact details, links, years, titles) plus the humanization scanner the writing skills describe. Call it once with the full draft or blocks, fix what it reports, then write. Writing skills' scripts and word lists run here; never open them yourself.`,
    effectClass: 'READ',
    notEvidence: true,
    keepsDraft: (params: { text?: string; blocks?: Block[] }) =>
      params.blocks && params.blocks.length > 0 ? JSON.stringify(params.blocks) : (params.text ?? ''),
    schema: z.object({
      kind: z.enum(['message', 'document']).describe('message: email or DM sent as the owner; document: resume, cover letter, bio, memo'),
      text: z.string().optional().describe('The full draft as plain text (for messages or docs_create)'),
      blocks: z.array(blockSchema).optional().describe('Structured blocks for document_render (if checking a formatted document)')
    }),
    execute: async (params: { kind: 'message' | 'document'; text?: string; blocks?: Block[] }, context) => {
      const isBlocks = Boolean(params.blocks && params.blocks.length > 0);
      const textToReview = isBlocks
        ? readingOrder(params.blocks!).join('\n')
        : (params.text ?? '');

      const blockProblems = isBlocks ? validateBlocks(params.blocks!) : [];
      const review = await reviewOwnerText(guard, params.kind, textToReview, { evidence: context.evidence, identity: true, style: true });
      const styleFixes = review.style?.mustFix ?? [];
      const sourcesRead = Boolean(context.ownerSourcesRead);
      const allRefusals = [...blockProblems.map(p => `[Block Error] ${p}`), ...review.refusals];
      const wouldBeWritten = allRefusals.length === 0 && sourcesRead;
      return {
        wouldBeWritten,
        status: wouldBeWritten ? 'CLEAN_TO_WRITE' : 'NEEDS_FIXES',
        mustFix: allRefusals.length > 0 ? allRefusals : undefined,
        styleMustFix: styleFixes.length > 0 ? styleFixes : undefined,
        sourcesRead: sourcesRead ? undefined : `Not yet: read ${OWNER_NAME}'s sources with owner_sources_read before writing.`,
        nextStep: wouldBeWritten
          ? 'Clean. Write it now: pass draftHandle as the text of the write (or as blocks for document_render) instead of repeating the draft; do not check it again or re-draft for optional style notes.'
          : 'Fix only the items listed, then write. Check again only if you changed claims, figures or contact details.'
      };
    }
  };
}
