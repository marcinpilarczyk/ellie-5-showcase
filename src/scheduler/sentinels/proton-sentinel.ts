import { ProtonMailClient } from '../../integrations/proton/client.js';
import { ModelRouter } from '../../models/model-router.js';
import { ActionLedgerRepository } from '../../storage/action-ledger.js';
import { RoutineRepository, SentinelSenderRule } from '../../storage/routine-repo.js';
import { SlackClient } from '../../integrations/slack/client.js';
import { buildQuoteCardBlocks } from '../../integrations/slack/cards.js';
import { NudgeGate, NudgePriority } from '../nudge-gate.js';
import { matchesSenderRule, SentinelRunResult } from './gmail-sentinel.js';
import { OWNER_FULL_NAME, OWNER_NAME } from '../../config/owner.js';
import { isLikelyAutomatedEmail, processEmailPostTriage } from './email-triage.js';
import { ClaimsGuard, reviewOwnerText } from '../../governance/claims-bank.js';

function canPostSlack(slackClient?: SlackClient): slackClient is SlackClient {
  if (!slackClient) return false;
  if (typeof slackClient.isConfigured === 'function') return slackClient.isConfigured();
  return typeof slackClient.postMessage === 'function';
}

function allowNudge(
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

interface ProtonTriageOutcome {
  msgKey: string;
  ignored?: boolean;
  isVip?: boolean;
  priority: NudgePriority;
  from: string;
  subject: string;
  surfaceSummary?: string;
  draft?: Record<string, any>;
}

import { WaitingRepository } from '../../storage/waiting-repo.js';

export class ProtonSentinel {
  constructor(
    private readonly protonClient: ProtonMailClient,
    private readonly modelRouter: ModelRouter,
    private readonly ledgerRepo: ActionLedgerRepository,
    private readonly routineRepo?: RoutineRepository,
    private readonly slackClient?: SlackClient,
    private readonly nudgeGate?: NudgeGate,
    private readonly claimsGuard?: ClaimsGuard,
    private readonly waitingRepo?: WaitingRepository
  ) {}

  public async runCheck(): Promise<SentinelRunResult> {
    if (this.routineRepo && !this.routineRepo.getSentinel('proton_sentinel').is_active) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'off' };
    }

    if (!this.protonClient.isEnabled()) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'not_connected' };
    }

    // --- CHEAP DETECT (UIDNEXT & UNSEEN) ---
    let status: { uidNext: number; unseen: number; messages: number };
    try {
      status = await this.protonClient.getMailboxStatus('INBOX');
    } catch (err: any) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: false, status: 'error', error: err.message };
    }

    let lastUidNext = 0;
    let seenIds: string[] = [];
    if (this.routineRepo) {
      const record = this.routineRepo.getSentinel('proton_sentinel');
      try {
        const state = JSON.parse(record.state_json || '{}');
        lastUidNext = state.uidNext || 0;
        const existingSeen = Array.isArray(state.seen_ids)
          ? state.seen_ids
          : (Array.isArray(state.seenUids) ? state.seenUids : []);
        seenIds = existingSeen.map(String);
      } catch {}
    }

    // If no unread messages and UIDNEXT has not advanced, skip downloading bodies & calling LLM!
    if (status.unseen === 0 && lastUidNext > 0 && status.uidNext === lastUidNext) {
      if (this.routineRepo) {
        this.routineRepo.updateSentinelCheck(
          'proton_sentinel',
          JSON.stringify({ uidNext: status.uidNext, unseen: 0, seen_ids: seenIds })
        );
      }
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'unchanged' };
    }

    // New messages arrived or unread count > 0 -> fetch unread messages
    let unread: any[] = [];
    try {
      unread = await this.protonClient.listUnread(5);
    } catch (err: any) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: false, status: 'error', error: err.message };
    }

    const seenSet = new Set(seenIds);
    const getMsgKey = (m: any): string => String(m?.uid ?? m?.id ?? m?.messageId ?? '');
    const fresh = unread.filter(m => {
      const key = getMsgKey(m);
      return key && !seenSet.has(key);
    });

    const rules = this.routineRepo ? this.routineRepo.listSenderRules('proton_sentinel') : [];
    const outcomes = await Promise.all(
      fresh.map(msg => this.evaluateMessage(msg, getMsgKey(msg), rules).catch(() => null))
    );

    let processedCount = 0;
    let draftsStagedCount = 0;
    let surfacedCount = 0;

    for (const outcome of outcomes) {
      if (!outcome) continue;
      processedCount++;
      if (outcome.ignored) continue;

      const res = await processEmailPostTriage(outcome, {
        sourceName: 'proton_sentinel',
        providerLabel: 'Proton',
        actionType: 'proton_draft',
        ledgerRepo: this.ledgerRepo,
        slackClient: this.slackClient,
        nudgeGate: this.nudgeGate,
        claimsGuard: this.claimsGuard,
        waitingRepo: this.waitingRepo
      });

      if (res.draftStaged) draftsStagedCount++;
      if (res.surfaced) surfacedCount++;
    }

    if (this.routineRepo) {
      const nextSeen = [...seenIds, ...fresh.map(getMsgKey)].slice(-200);
      this.routineRepo.updateSentinelCheck(
        'proton_sentinel',
        JSON.stringify({
          uidNext: status.uidNext,
          unseen: status.unseen,
          seen_ids: nextSeen,
          processedCount,
          draftsStagedCount,
          surfacedCount
        })
      );
    }

    return { processedCount, draftsStagedCount, surfacedCount, cheapSkipped: false };
  }

  private async evaluateMessage(msg: any, msgKey: string, rules: SentinelSenderRule[]): Promise<ProtonTriageOutcome | null> {
    const fromEmail = String(msg.fromEmail || (msg.from?.match(/<([^>]+)>/)?.[1] || msg.from || '')).trim();
    const from = msg.fromName && fromEmail
      ? `${msg.fromName} <${fromEmail}>`
      : (msg.from || fromEmail || '');
    const subject = String(msg.subject || '');
    const snippet = String(msg.snippet || msg.textBody || msg.body || '');

    const ignoreRule = rules.find(r => r.rule_type === 'ignore' && matchesSenderRule(from, r.pattern));
    if (ignoreRule) {
      return {
        msgKey,
        ignored: true,
        priority: 'normal',
        from,
        subject
      };
    }

    const vipRule = rules.find(r => r.rule_type === 'vip' && matchesSenderRule(from, r.pattern));
    const isVip = Boolean(vipRule);

    // 2. Deterministic Pre-Triage: filter bulk/automated/newsletter emails at 0 tokens
    if (!isVip && isLikelyAutomatedEmail({ from, fromEmail, subject, snippet, headers: msg.headers, isVip })) {
      return {
        msgKey,
        ignored: true,
        priority: 'normal',
        from,
        subject
      };
    }

    if (!this.modelRouter || typeof this.modelRouter.generate !== 'function') {
      return {
        msgKey,
        isVip,
        priority: isVip ? 'urgent' : 'normal',
        from,
        subject,
        surfaceSummary: isVip ? (snippet || subject || 'VIP message') : undefined
      };
    }

    const classifyPrompt = `Analyze this inbound Proton Mail message to ${OWNER_FULL_NAME} and decide if it needs a reply.
From: ${from}
Subject: ${subject}
Snippet: "${snippet}"

Output JSON:
{
  "requiresAction": true|false,
  "category": "URGENT"|"INFORMATIONAL"|"SPAM"|"NEWSLETTER",
  "recommendedAction": "draft_reply"|"ignore"|"surface",
  "reason": "1 sentence reason",
  "draftBody": "If draft_reply: a short, specific reply in the sender's language, signed ${OWNER_NAME}. Never invent commitments, dates or facts. Otherwise empty."
}`;

    const classification = await this.modelRouter.generate(classifyPrompt, {
      tier: 'SENTINEL',
      temperature: 0.0,
      responseMimeType: 'application/json'
    });

    let parsed: any = {};
    try { parsed = JSON.parse(classification.text); } catch {}

    const rawAction = String(parsed.recommendedAction || parsed.action || '').toLowerCase();
    const draftBody = String(parsed.draftBody || parsed.draft?.body || parsed.body || '').trim();
    const to = fromEmail || (from.match(/<([^>]+)>/)?.[1] || from).trim();
    const priority: NudgePriority =
      isVip || String(parsed.category || '').toUpperCase() === 'URGENT' || parsed.priority === 'urgent' || parsed.priority === 'high'
        ? 'urgent'
        : 'normal';

    const wantsDraft =
      (rawAction === 'draft_reply' || rawAction === 'draft') &&
      parsed.requiresAction !== false &&
      Boolean(to && draftBody);

    if (wantsDraft) {
      return {
        msgKey,
        isVip,
        priority,
        from,
        subject,
        draft: {
          to,
          subject: subject && !/^re:/i.test(subject) ? `Re: ${subject}` : (subject || 'Re:'),
          body: draftBody,
          ...(msg.messageId ? { inReplyTo: msg.messageId } : {})
        }
      };
    }

    const wantsSurface =
      rawAction === 'surface' ||
      rawAction === 'notify' ||
      isVip;

    if (wantsSurface) {
      return {
        msgKey,
        isVip,
        priority,
        from,
        subject,
        surfaceSummary: String(parsed.summary || parsed.reason || snippet || subject || 'Important message').trim()
      };
    }

    return {
      msgKey,
      isVip,
      priority,
      from,
      subject
    };
  }
}
