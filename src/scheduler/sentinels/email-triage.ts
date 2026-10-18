/**
 * Deterministic Email Pre-Triage Heuristics.
 * 
 * Filters out automated bulk newsletters, notifications, digests, and receipts
 * in plain host code (<1ms, 0 tokens) before calling LLM sentinels.
 * 
 * Safety invariants:
 * 1. VIP senders are NEVER filtered out (caller checks VIP before this or passes isVip).
 * 2. Critical security, password reset, 2FA, and authentication alerts are NEVER filtered out.
 */

export interface AutomatedEmailCheckParams {
  from: string;
  fromEmail?: string;
  subject?: string;
  snippet?: string;
  headers?: Array<{ name?: string; value?: string }> | Record<string, unknown>;
  isVip?: boolean;
}

const SECURITY_AUTH_PATTERN = /\b(security alert|unauthorized|suspicious|password reset|reset hasła|verify your|verification code|kod weryfikacyjny|one-time (passcode|password)|2fa|mfa|account (suspended|locked|compromised))\b/i;

const AUTOMATED_SENDER_PATTERN = /\b(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce|notifications?|alerts?|updates?|newsletters?|marketing|digest|automated|billing|invoices?|receipts?)@/i;

const AUTOMATED_SUBJECT_PREFIX_PATTERN = /^(\[?(daily|weekly|monthly)\s+(digest|newsletter|roundup|update)\]?|your\s+(weekly|daily|monthly)\s+digest|.*(receipt|donation receipt|order confirmation|payment confirmation|faktura|potwierdzenie zamówienia)\b)/i;

export function isLikelyAutomatedEmail(params: AutomatedEmailCheckParams): boolean {
  // Invariant 1: VIPs are never auto-ignored
  if (params.isVip) return false;

  const subject = (params.subject || '').trim();
  const snippet = (params.snippet || '').trim();
  const combinedText = `${subject} ${snippet}`;

  // Invariant 2: Security alerts, 2FA, password resets are NEVER auto-ignored
  if (SECURITY_AUTH_PATTERN.test(combinedText)) {
    return false;
  }

  // 1. Check RFC Bulk / Auto-Submitted headers
  if (params.headers) {
    if (Array.isArray(params.headers)) {
      const headersList = params.headers as Array<{ name?: string; value?: string }>;
      const getH = (name: string) => headersList.find(h => h.name?.toLowerCase() === name)?.value?.toLowerCase() || '';
      
      // Standard List-Unsubscribe header means it is an automated broadcast/newsletter list
      if (getH('list-unsubscribe')) return true;

      // RFC Precedence header (bulk, list, junk)
      const precedence = getH('precedence');
      if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;

      // RFC Auto-Submitted header
      const autoSubmitted = getH('auto-submitted');
      if (autoSubmitted && autoSubmitted !== 'no') return true;
    } else if (typeof params.headers === 'object') {
      const headers = params.headers as Record<string, any>;
      const getH = (name: string) => {
        const val = headers[name] || headers[name.toLowerCase()];
        return (Array.isArray(val) ? val.join(' ') : String(val || '')).toLowerCase();
      };
      if (getH('list-unsubscribe')) return true;
      const precedence = getH('precedence');
      if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true;
      const autoSubmitted = getH('auto-submitted');
      if (autoSubmitted && autoSubmitted !== 'no') return true;
    }
  }

  // 2. Automated sender email addresses
  const from = (params.from || '').trim();
  const fromEmail = (params.fromEmail || from.match(/<([^>]+)>/)?.[1] || from).trim();
  if (AUTOMATED_SENDER_PATTERN.test(fromEmail)) {
    return true;
  }

  // 3. Automated subject patterns (digests, roundups)
  if (AUTOMATED_SUBJECT_PREFIX_PATTERN.test(subject)) {
    return true;
  }

  return false;
}

import { ActionLedgerRepository } from '../../storage/action-ledger.js';
import { SlackClient } from '../../integrations/slack/client.js';
import { buildQuoteCardBlocks } from '../../integrations/slack/cards.js';
import { NudgeGate, NudgePriority } from '../nudge-gate.js';
import { ClaimsGuard, reviewOwnerText } from '../../governance/claims-bank.js';
import { WaitingRepository } from '../../storage/waiting-repo.js';

export function canPostSlack(slackClient?: SlackClient): slackClient is SlackClient {
  if (!slackClient) return false;
  if (typeof slackClient.isConfigured === 'function') return slackClient.isConfigured();
  return typeof slackClient.postMessage === 'function';
}

export function allowNudge(
  nudgeGate: NudgeGate | undefined,
  req: { source: string; priority: NudgePriority; text: string; dedupeKey?: string }
): boolean {
  if (!nudgeGate) return true;
  const evalFn = typeof nudgeGate.evaluate === 'function'
    ? nudgeGate.evaluate.bind(nudgeGate)
    : nudgeGate.admit.bind(nudgeGate);
  const res = evalFn(req);
  return res.decision.action === 'SEND';
}

export interface EmailTriageOutcome {
  threadId?: string;
  msgKey?: string;
  ignored?: boolean;
  isVip?: boolean;
  priority: NudgePriority;
  from: string;
  subject: string;
  surfaceSummary?: string;
  draft?: Record<string, any>;
}

export interface EmailPostTriageDeps {
  sourceName: 'gmail_sentinel' | 'proton_sentinel';
  providerLabel: 'Gmail' | 'Proton';
  actionType: 'gmail_draft' | 'proton_draft';
  ledgerRepo: ActionLedgerRepository;
  slackClient?: SlackClient;
  nudgeGate?: NudgeGate;
  claimsGuard?: ClaimsGuard;
  waitingRepo?: WaitingRepository;
}

export interface EmailPostTriageResult {
  draftStaged: boolean;
  surfaced: boolean;
  waitingResolved: number;
}

export async function processEmailPostTriage(
  outcome: EmailTriageOutcome,
  deps: EmailPostTriageDeps
): Promise<EmailPostTriageResult> {
  const itemKey = outcome.threadId || outcome.msgKey || '';
  let waitingResolved = 0;
  const resolvedNotes: string[] = [];

  // Check and auto-resolve active waiting items matching sender or threadId
  if (deps.waitingRepo) {
    try {
      const activeItems = deps.waitingRepo.list({ status: 'active' });
      const fromLower = (outcome.from || '').toLowerCase();
      for (const item of activeItems) {
        const matchesThread = Boolean(item.thread_ref && (item.thread_ref === outcome.threadId || item.thread_ref === outcome.msgKey));
        const cpLower = (item.counterparty || '').trim().toLowerCase();
        const matchesCp = cpLower.length >= 3 && fromLower.includes(cpLower);
        if (matchesThread || matchesCp) {
          deps.waitingRepo.resolve(item.id, `Reply received via ${deps.providerLabel}`);
          resolvedNotes.push(`✅ Resolved waiting item: *${item.subject}*`);
          waitingResolved++;
        }
      }
    } catch (wErr: any) {
      console.warn(`[${deps.providerLabel}Sentinel] Error checking waiting items:`, wErr.message);
    }
  }

  let draftStaged = false;
  let surfaced = false;

  if (outcome.draft) {
    // Enforce ClaimsBankGuard before staging
    let safeDraft = true;
    if (deps.claimsGuard) {
      try {
        const check = await reviewOwnerText(
          deps.claimsGuard,
          'message',
          `${outcome.draft['subject'] || ''}\n${outcome.draft['body'] || ''}`,
          {
            evidence: [outcome.from, outcome.subject || '', outcome.surfaceSummary || ''],
            identity: true
          }
        );
        if (check.refusals.length > 0) {
          safeDraft = false;
          outcome.surfaceSummary = `Reply drafted, but held due to unverified claims: ${check.refusals.join('; ')}\nProposed: "${outcome.draft['body']?.slice(0, 140)}..."`;
          outcome.draft = undefined;
        }
      } catch {
        // Fails closed on claims check error
        safeDraft = false;
        outcome.surfaceSummary = `Reply drafted, but held: Claims check unavailable.`;
        outcome.draft = undefined;
      }
    }

    if (safeDraft && outcome.draft) {
      const actionId = deps.sourceName === 'proton_sentinel'
        ? `proton_draft_${Date.now()}_${itemKey}`
        : `draft_${Date.now()}_${itemKey}`;

      deps.ledgerRepo.stageProposal({
        actionId,
        actionType: deps.actionType,
        payload: outcome.draft
      });
      draftStaged = true;

      let cardText = `📝 *${deps.providerLabel} draft staged*${outcome.isVip ? ' [VIP]' : ''} for ${outcome.draft['to']} — *${outcome.draft['subject']}*`;
      if (resolvedNotes.length > 0) {
        cardText += `\n${resolvedNotes.join('\n')}`;
      }
      const canSend = allowNudge(deps.nudgeGate, {
        source: deps.sourceName,
        priority: outcome.priority,
        text: cardText,
        dedupeKey: `${deps.actionType === 'proton_draft' ? 'proton_draft' : 'gmail_draft'}:${itemKey}`
      });
      if (canSend && canPostSlack(deps.slackClient)) {
        try {
          const posted = await deps.slackClient.postMessage({
            channel: deps.slackClient.defaultChannel,
            text: cardText,
            blocks: buildQuoteCardBlocks(actionId, deps.actionType, outcome.draft)
          });
          if (posted?.ts) {
            deps.ledgerRepo.updateSlackCardTs(actionId, posted.ts);
          }
        } catch {}
      }
    }
  }

  if (!outcome.draft && (outcome.surfaceSummary || resolvedNotes.length > 0)) {
    let text = `📬 *${deps.providerLabel}${outcome.isVip ? ' [VIP]' : ''}:* From ${outcome.from} — *${outcome.subject || '(no subject)'}*`;
    if (outcome.surfaceSummary) text += `\n${outcome.surfaceSummary}`;
    if (resolvedNotes.length > 0) text += `\n${resolvedNotes.join('\n')}`;

    const canSend = allowNudge(deps.nudgeGate, {
      source: deps.sourceName,
      priority: outcome.priority,
      text,
      dedupeKey: `${deps.sourceName === 'proton_sentinel' ? 'proton_surface' : 'gmail_surface'}:${itemKey}`
    });
    if (canSend && canPostSlack(deps.slackClient)) {
      try {
        await deps.slackClient.postMessage({
          channel: deps.slackClient.defaultChannel,
          text
        });
        surfaced = true;
      } catch {}
    }
  }

  return { draftStaged, surfaced, waitingResolved };
}
