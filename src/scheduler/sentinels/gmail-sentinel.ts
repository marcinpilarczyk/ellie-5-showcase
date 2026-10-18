import { GoogleWorkspaceClient } from '../../integrations/google/client.js';
import { ModelRouter } from '../../models/model-router.js';
import { ActionLedgerRepository } from '../../storage/action-ledger.js';
import { SlackClient } from '../../integrations/slack/client.js';
import { buildQuoteCardBlocks } from '../../integrations/slack/cards.js';
import { RoutineRepository, SentinelSenderRule } from '../../storage/routine-repo.js';
import { NudgeGate, NudgePriority } from '../nudge-gate.js';
import { OWNER_FULL_NAME, OWNER_NAME } from '../../config/owner.js';
import { isLikelyAutomatedEmail, processEmailPostTriage } from './email-triage.js';
import { ClaimsGuard, reviewOwnerText } from '../../governance/claims-bank.js';

export function matchesSenderRule(sender: string, pattern: string): boolean {
  const pat = (pattern || '').trim().toLowerCase();
  if (!pat) return false;
  const raw = (sender || '').trim().toLowerCase();
  const email = (sender.match(/<([^>]+)>/)?.[1] || sender).trim().toLowerCase();

  if (pat.includes('*')) {
    const regexStr = '^' + pat.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
    const regex = new RegExp(regexStr, 'i');
    return regex.test(email) || regex.test(raw);
  }
  if (pat.startsWith('@')) {
    return email.endsWith(pat) || raw.includes(pat);
  }
  return email === pat || email.endsWith(`@${pat}`) || raw.includes(pat);
}

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

interface ThreadTriageOutcome {
  threadId: string;
  ignored?: boolean;
  isVip?: boolean;
  priority: NudgePriority;
  from: string;
  subject: string;
  surfaceSummary?: string;
  draft?: Record<string, string>;
}

export type SentinelRunStatus = 'off' | 'not_connected' | 'error' | 'unchanged' | 'checked';

export interface SentinelRunResult {
  processedCount: number;
  draftsStagedCount: number;
  surfacedCount?: number;
  cheapSkipped?: boolean;
  status?: SentinelRunStatus;
  error?: string;
}

import { WaitingRepository } from '../../storage/waiting-repo.js';

export class GmailSentinel {
  constructor(
    private readonly googleClient: GoogleWorkspaceClient,
    private readonly modelRouter: ModelRouter,
    private readonly ledgerRepo: ActionLedgerRepository,
    private readonly routineRepo?: RoutineRepository,
    private readonly slackClient?: SlackClient,
    private readonly nudgeGate?: NudgeGate,
    private readonly claimsGuard?: ClaimsGuard,
    private readonly waitingRepo?: WaitingRepository
  ) {}

  public async runCheck(): Promise<SentinelRunResult> {
    if (this.routineRepo && !this.routineRepo.getSentinel('gmail_sentinel').is_active) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'off' };
    }

    if (!this.googleClient.isConnected()) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'not_connected' };
    }

    // --- CHEAP DETECT (historyId) ---
    let currentHistoryId = '';
    try {
      const profile = await this.googleClient.getGmailProfile();
      currentHistoryId = profile.historyId;
    } catch (err: any) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: false, status: 'error', error: err.message };
    }

    let lastHistoryId = '';
    let seenThreadIds: string[] = [];
    if (this.routineRepo) {
      const record = this.routineRepo.getSentinel('gmail_sentinel');
      try {
        const state = JSON.parse(record.state_json || '{}');
        lastHistoryId = state.historyId || '';
        const existingSeen = Array.isArray(state.seenThreadIds)
          ? state.seenThreadIds
          : (Array.isArray(state.seen_ids) ? state.seen_ids : []);
        seenThreadIds = existingSeen.map(String);
      } catch {}
    }

    if (lastHistoryId && currentHistoryId && lastHistoryId === currentHistoryId) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: true, status: 'unchanged' };
    }

    let unreadThreads: any[] = [];
    try {
      unreadThreads = await this.googleClient.listGmailThreads('is:unread', 5);
    } catch (err: any) {
      return { processedCount: 0, draftsStagedCount: 0, cheapSkipped: false, status: 'error', error: err.message };
    }
    const seen = new Set(seenThreadIds);
    const fresh = unreadThreads.filter(t => t?.id && !seen.has(String(t.id)));
    const rules = this.routineRepo ? this.routineRepo.listSenderRules('gmail_sentinel') : [];

    const outcomes = await Promise.all(
      fresh.map(thread => this.evaluateThread(String(thread.id), rules).catch(() => null))
    );

    let processedCount = 0;
    let draftsStagedCount = 0;
    let surfacedCount = 0;

    for (const outcome of outcomes) {
      if (!outcome) continue;
      processedCount++;
      if (outcome.ignored) continue;

      const res = await processEmailPostTriage(outcome, {
        sourceName: 'gmail_sentinel',
        providerLabel: 'Gmail',
        actionType: 'gmail_draft',
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
      const nextSeen = [...seenThreadIds, ...fresh.map(t => String(t.id))].slice(-200);
      this.routineRepo.updateSentinelCheck(
        'gmail_sentinel',
        JSON.stringify({
          historyId: currentHistoryId,
          seenThreadIds: nextSeen,
          seen_ids: nextSeen,
          processedCount,
          draftsStagedCount,
          surfacedCount
        })
      );
    }

    return { processedCount, draftsStagedCount, surfacedCount, cheapSkipped: false };
  }

  private async evaluateThread(threadId: string, rules: SentinelSenderRule[]): Promise<ThreadTriageOutcome | null> {
    const fullThread: any = await this.googleClient.getGmailThread(threadId);
    if (!fullThread) return null;

    let from = '';
    let subject = '';
    let snippet = '';

    const lastMsg = Array.isArray(fullThread.messages)
      ? fullThread.messages[fullThread.messages.length - 1]
      : fullThread;
    if (!lastMsg) return null;

    const headers: Array<{ name?: string; value?: string }> = lastMsg.payload?.headers || [];
    const header = (name: string) => headers.find(h => h.name?.toLowerCase() === name)?.value || '';
    from = header('reply-to') || header('from') || lastMsg.from || fullThread.from || '';
    subject = header('subject') || lastMsg.subject || fullThread.subject || '';
    snippet = lastMsg.snippet || fullThread.snippet || lastMsg.body || '';

    // 1. Check sender rules BEFORE calling LLM
    const ignoreRule = rules.find(r => r.rule_type === 'ignore' && matchesSenderRule(from, r.pattern));
    if (ignoreRule) {
      return {
        threadId,
        ignored: true,
        priority: 'normal',
        from,
        subject
      };
    }

    const vipRule = rules.find(r => r.rule_type === 'vip' && matchesSenderRule(from, r.pattern));
    const isVip = Boolean(vipRule);

    // 2. Deterministic Pre-Triage: filter bulk/automated/newsletter emails at 0 tokens
    if (!isVip && isLikelyAutomatedEmail({ from, subject, snippet, headers, isVip })) {
      return {
        threadId,
        ignored: true,
        priority: 'normal',
        from,
        subject
      };
    }

    const classifyPrompt = `Analyze this inbound email to ${OWNER_FULL_NAME} and decide if it needs a reply.
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
    const to = (from.match(/<([^>]+)>/)?.[1] || from).trim();
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
        threadId,
        isVip,
        priority,
        from,
        subject,
        draft: {
          to,
          threadId,
          subject: subject && !/^re:/i.test(subject) ? `Re: ${subject}` : (subject || 'Re:'),
          body: draftBody
        }
      };
    }

    const wantsSurface =
      rawAction === 'surface' ||
      rawAction === 'notify' ||
      isVip;

    if (wantsSurface) {
      return {
        threadId,
        isVip,
        priority,
        from,
        subject,
        surfaceSummary: String(parsed.summary || parsed.reason || snippet || subject || 'Important message').trim()
      };
    }

    return {
      threadId,
      isVip,
      priority,
      from,
      subject
    };
  }
}
