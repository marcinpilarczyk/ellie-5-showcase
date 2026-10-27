import { ModelRouter } from '../models/model-router.js';

export interface ExtractionInput {
  actionType: string;
  feedback?: string;
  oldPayload: Record<string, any>;
  newPayload: Record<string, any>;
}

export function extractDiffSpecificTokens(
  oldPayload: Record<string, any> = {},
  newPayload: Record<string, any> = {}
): {
  currencies: Set<string>;
  percentages: Set<string>;
  specificTokens: Set<string>;
} {
  const currencies = new Set<string>();
  const percentages = new Set<string>();
  const specificTokens = new Set<string>();

  const jsonOld = JSON.stringify(oldPayload || {});
  const jsonNew = JSON.stringify(newPayload || {});
  const combined = `${jsonOld} ${jsonNew}`;

  // Currency amounts (e.g. $45,000, €100k, PLN 5000, £250, USD 1,000)
  const figureMatches = combined.match(/(?:[$€£]\s?\d[\d,.]*[kKmMbB]?|\b(?:USD|EUR|PLN|GBP)\s?\d[\d,.]*)/gi) ?? [];
  for (const fig of figureMatches) {
    currencies.add(fig.trim().toLowerCase());
  }

  // Percentages (\b\d+(\.\d+)?%)
  const pctMatches = combined.match(/\b\d+(?:\.\d+)?%/g) ?? [];
  for (const pct of pctMatches) {
    percentages.add(pct.trim().toLowerCase());
  }

  // Explicit payload fields
  const payloadFields = ['to', 'recipient', 'counterparty', 'threadId', 'docId', 'channel', 'spreadsheetId', 'documentId', 'channelId', 'doc_id', 'thread_ts', 'file_id'];
  const checkAndAdd = (val: any) => {
    if (typeof val === 'string' && val.trim().length >= 2) {
      specificTokens.add(val.trim().toLowerCase());
    }
  };
  for (const f of payloadFields) {
    if (oldPayload) checkAndAdd(oldPayload[f]);
    if (newPayload) checkAndAdd(newPayload[f]);
  }

  // Multi-word proper nouns
  const properMatches = combined.match(/\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+\b/gu) ?? [];
  for (const m of properMatches) {
    const lower = m.trim().toLowerCase();
    if (/^(dear\s+|thanks|thank\s+you|best\s+regards|kind\s+regards|sincerely|yours\b)/i.test(lower)) continue;
    if (lower.length >= 3) {
      specificTokens.add(lower);
    }
  }

  // Alphanumeric IDs (e.g. th_123, act_999, inv_123, C0EXAMPLE, /EllieOS/..., 179... thread IDs, UUIDs)
  const idMatches = combined.match(/(?:\b[a-zA-Z]{2,8}_[a-zA-Z0-9_-]{3,}\b|\b[CUW][0-9A-Z]{8,}\b|\/EllieOS\/[\w/.-]+|\b17\d{8,}(?:\.\d+)?\b|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b)/g) ?? [];
  for (const idToken of idMatches) {
    specificTokens.add(idToken.trim().toLowerCase());
  }

  // Long opaque identifiers (15+ chars alphanumeric with digits)
  const longOpaque = combined.match(/\b(?=[a-zA-Z0-9_-]{15,}\b)(?=[a-zA-Z0-9_-]*\d)(?=[a-zA-Z0-9_-]*[a-zA-Z])[a-zA-Z0-9_-]+\b/g) ?? [];
  for (const lo of longOpaque) {
    specificTokens.add(lo.trim().toLowerCase());
  }

  return { currencies, percentages, specificTokens };
}

export function screenCandidateLeakage(
  lesson: string,
  input: ExtractionInput
): { leaked: boolean; reason?: string } {
  const trimmedLesson = (lesson || '').trim();
  if (!trimmedLesson) {
    return { leaked: true, reason: 'Empty lesson' };
  }

  // Cap complexity (Ridge/L2 per-rule word cap: reject prose dumps > 35 words)
  const wordCount = trimmedLesson.split(/\s+/).filter(Boolean).length;
  if (wordCount > 35) {
    return { leaked: true, reason: 'Exceeds maximum rule length (35 words)' };
  }

  // Reject if lesson contains any email address, URL, phone number, or ISO date
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.test(trimmedLesson)) {
    return { leaked: true, reason: 'Contains email address' };
  }
  if (/https?:\/\/\S+|www\.\S+/i.test(trimmedLesson)) {
    return { leaked: true, reason: 'Contains URL' };
  }
  if (/\+?\d[\d\s().-]{7,}\d/.test(trimmedLesson)) {
    return { leaked: true, reason: 'Contains phone number' };
  }
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(trimmedLesson)) {
    return { leaked: true, reason: 'Contains ISO date' };
  }

  const { currencies, percentages, specificTokens } = extractDiffSpecificTokens(input.oldPayload, input.newPayload);
  const lessonLower = trimmedLesson.toLowerCase();

  // Block payload currency figures
  for (const curr of currencies) {
    if (lessonLower.includes(curr)) {
      return { leaked: true, reason: `Contains payload currency figure: ${curr}` };
    }
  }

  // Block payload percentages
  for (const pct of percentages) {
    if (lessonLower.includes(pct)) {
      return { leaked: true, reason: `Contains payload percentage: ${pct}` };
    }
  }

  const feedbackLower = (input.feedback || '').toLowerCase();
  const explicitAlwaysNever = /\b(always|never)\b/i.test(feedbackLower);

  for (const token of specificTokens) {
    if (token.length >= 2 && lessonLower.includes(token)) {
      if (!explicitAlwaysNever || !feedbackLower.includes(token)) {
        return { leaked: true, reason: 'Contains task-specific entity, figure, or payload token' };
      }
    }
  }

  return { leaked: false };
}

/**
 * Extracts a concise 1-sentence style/tone lesson from an owner correction or revision.
 * Returns null if the change is purely situational/factual or if no generalizable lesson exists.
 */
export async function extractCorrectionLesson(
  modelRouter: ModelRouter | undefined,
  input: ExtractionInput
): Promise<string | null> {
  // If model router is not available or mock/offline, fall back to simple heuristic if feedback is short
  if (!modelRouter || typeof modelRouter.generate !== 'function') {
    if (input.feedback && input.feedback.trim().length > 0 && input.feedback.trim().length <= 150) {
      const trimmed = input.feedback.trim();
      if (/^https?:\/\//i.test(trimmed) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return null;
      }
      const candidate = trimmed.replace(/^["']|["']$/g, '');
      const screen = screenCandidateLeakage(candidate, input);
      if (screen.leaked) return null;
      return candidate;
    }
    return null;
  }

  const prompt = `You are Ellie's self-improvement module. The owner just corrected or revised a staged action draft (${input.actionType}).

${input.feedback ? `OWNER'S IN-THREAD CORRECTION / FEEDBACK:\n"${input.feedback}"\n` : ''}
ORIGINAL PAYLOAD:
${JSON.stringify(input.oldPayload)}

REVISED PAYLOAD:
${JSON.stringify(input.newPayload)}

Analyze what changed and why.
If this correction conveys a generalizable style, tone, phrasing, or communication preference for future drafts (for example:
- "Do not open emails with conversational filler like 'Hope this email finds you well'."
- "Keep executive outreach drafts under 3 sentences."
- "Never mention pricing or rates before a discovery call."
- "Use 'Best' instead of 'Sincerely' in email sign-offs."):
Output EXACTLY ONE concise, imperative 1-sentence lesson (under 25 words). No markdown, no quotes, no preamble.

If the change is purely situational, factual, or one-off (such as correcting a recipient's name or email address, fixing a specific date/time, fixing a typo, or adding a specific document link):
Output ONLY the word: NONE`;

  try {
    const resp = await modelRouter.generate(prompt, {
      tier: 'SENTINEL',
      temperature: 0,
      source: 'correction_extractor'
    });

    const text = resp?.text ? resp.text.trim().replace(/^["']|["']$/g, '').trim() : '';
    if (!text || text.toUpperCase() === 'NONE' || text.toUpperCase().startsWith('NONE.') || text.toUpperCase().startsWith('NONE:')) {
      return null;
    }

    const firstLine = text.split('\n')[0].trim();
    if (!firstLine || firstLine.toUpperCase() === 'NONE') return null;

    const candidate = firstLine.slice(0, 250);
    const screen = screenCandidateLeakage(candidate, input);
    if (screen.leaked) return null;

    return candidate;
  } catch (err: any) {
    console.warn('[CorrectionExtractor] Error generating lesson from correction:', err.message);
    return null;
  }
}
