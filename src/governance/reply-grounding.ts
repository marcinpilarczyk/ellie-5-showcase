import type { ToolCallExecutionRecord } from '../types/runner.js';
import type { ActionLedgerRecord } from '../types/action.js';

const GOOGLE_URL = /https?:\/\/(?:docs|drive)\.google\.com\/[^\s)\]>]*/gi;
const ID_IN_URL = /\/(?:d|folders)\/([A-Za-z0-9_-]+)/;
const CREATE_CLAIM = /\b(i(?:'ve| have)?\s+(?:now\s+)?(?:created|generated|drafted|saved|built)|has been created|stworzyłem|utworzyłem|przygotowałem)\b/i;
const CREATE_TOOLS = /(create|draft|append|append_row|render|write)/i;
const ACTION_TOOLS = /(create|draft|append|append_row|send|render|update|delete|write)/i;
const FAILED_STATES = new Set(['FAILED', 'FAILED_SAFE', 'RECONCILIATION_REQUIRED']);

function resultText(calls: ToolCallExecutionRecord[]): string {
  return calls.map(c => { try { return JSON.stringify(c.result ?? ''); } catch { return ''; } }).join('\n');
}

function succeeded(c: ToolCallExecutionRecord): boolean {
  const r: any = c.result;
  if (r == null) return false;
  if (typeof r === 'object') {
    if (r.error || r.ok === false) return false;
    if (typeof r.outcome === 'string' && FAILED_STATES.has(r.outcome.toUpperCase())) return false;
    if (typeof r.status === 'string' && FAILED_STATES.has(r.status.toUpperCase())) return false;
    if (typeof r.state === 'string' && FAILED_STATES.has(r.state.toUpperCase())) return false;
    if (r.readBack && r.readBack.status === 'ABSENT') return false;
  }
  return true;
}

interface FailedActionInfo {
  name: string;
  state: string;
  error?: string;
}

function collectFailedActions(
  calls: ToolCallExecutionRecord[],
  ledgerEntries?: ReadonlyArray<Partial<ActionLedgerRecord> & Record<string, any>>
): FailedActionInfo[] {
  const failures: FailedActionInfo[] = [];
  const seenKeys = new Set<string>();

  // 1. Check explicit ledger entries
  for (const entry of ledgerEntries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const rawState = String(entry.state || entry.status || '').toUpperCase();
    if (!FAILED_STATES.has(rawState)) continue;
    const name = String(entry.action_type || entry.actionType || entry.tool || 'action');
    const error = String(entry.last_error || entry.error || '').trim() || undefined;
    const key = `${name}:${rawState}:${error || ''}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      failures.push({ name, state: rawState, error });
    }
  }

  // 2. Check calls array (including ledger-shaped records or failed tool calls)
  for (let i = 0; i < calls.length; i++) {
    const c: any = calls[i];
    if (!c || typeof c !== 'object') continue;

    // Support ledger-shaped record passed directly in calls
    const directState = String(c.state || c.status || '').toUpperCase();
    if (FAILED_STATES.has(directState) && (c.action_type || c.actionType || c.tool)) {
      const name = String(c.action_type || c.actionType || c.tool);
      const error = String(c.last_error || c.error || c.result?.error || '').trim() || undefined;
      const key = `${name}:${directState}:${error || ''}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        failures.push({ name, state: directState, error });
      }
      continue;
    }

    const toolName = String(c.tool || '');
    if (!toolName) continue;
    if (succeeded(c)) continue;

    const r: any = c.result;
    const resState = String(r?.state || r?.status || r?.outcome || '').toUpperCase();
    const isExplicitFailureState = FAILED_STATES.has(resState);
    const isReadBackAbsent = r?.readBack?.status === 'ABSENT';
    const isActionTool = ACTION_TOOLS.test(toolName);

    if (!isExplicitFailureState && !isReadBackAbsent && !isActionTool) continue;

    // If a later call to the same tool in this run succeeded, the retry resolved the earlier error
    const resolvedLater = calls.slice(i + 1).some(later => later?.tool === toolName && succeeded(later));
    if (resolvedLater && resState !== 'RECONCILIATION_REQUIRED') continue;

    const stateLabel = isExplicitFailureState ? resState : 'FAILED';
    const error = String(r?.error || r?.last_error || r?.readBack?.detail || r?.details || '').trim() || undefined;
    const key = `${toolName}:${stateLabel}:${error || ''}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      failures.push({ name: toolName, state: stateLabel, error });
    }
  }

  return failures;
}

import { extractClaimKeys, type ClaimKey } from './claims-bank.js';

const TIME_UNITS = new Set(['day', 'week', 'month', 'year', 'yr', 'quarter']);

/** P7/P8: a link or a "done" claim in a reply must be backed by a tool result from this run. */
export function groundReply(
  text: string | undefined,
  calls: ToolCallExecutionRecord[],
  ledgerEntries?: ReadonlyArray<Partial<ActionLedgerRecord> & Record<string, any>>,
  extraEvidenceTexts?: readonly string[]
): string | undefined {
  if (!text) return text;
  const isBareUrl = /^https?:\/\/\S+$/i.test(text.trim());
  const evidence = resultText(calls);
  let out = text.replace(GOOGLE_URL, (url) => {
    const id = ID_IN_URL.exec(url)?.[1];
    return id && id.length >= 20 && evidence.includes(id) ? url : '[link withheld: not verified]';
  });
  // Drop markdown wrappers left dangling by a truncated or withheld link.
  out = out.replace(/\[([^\]]*)\]\(\[link withheld: not verified\]\)?/g, '$1 [link withheld: not verified]');

  if (isBareUrl) return out;

  const hasWrite = calls.some(c => c?.tool && CREATE_TOOLS.test(c.tool) && succeeded(c));
  if (CREATE_CLAIM.test(out) && !hasWrite) {
    out += '\n\n_Note: no create/write tool call succeeded in this run, so treat the above as not done._';
  }

  const failedActions = collectFailedActions(calls, ledgerEntries);
  const undisclosed = failedActions.filter(f => {
    // If the reply already contains the exact error message or names the tool + failed, do not duplicate
    if (f.error && f.error.length >= 12 && out.includes(f.error)) return false;
    const mentionsTool = out.toLowerCase().includes(f.name.toLowerCase());
    const mentionsFail = /\b(failed|failed_safe|reconciliation_required|error)\b/i.test(out);
    if (mentionsTool && mentionsFail && (!f.error || out.toLowerCase().includes(f.error.slice(0, 20).toLowerCase()))) {
      return false;
    }
    return true;
  });

  if (undisclosed.length > 0) {
    const details = undisclosed.map(f => {
      const statusTag = f.state.includes('FAILED') ? f.state : `FAILED (${f.state})`;
      return f.error ? `${f.name} [${statusTag}: ${f.error}]` : `${f.name} [${statusTag}]`;
    }).join('; ');
    out += `\n\n_Note: failed action in this run — ${details}._`;
  }

  // P8: Hard figures in Slack replies without false-flagging conversational numbers
  if (calls.length > 0) {
    const fullEvidenceText = [
      resultText(calls),
      (extraEvidenceTexts ?? []).join('\n'),
      JSON.stringify(calls.map(c => c.params ?? ''))
    ].join('\n');

    const evidenceKeys = extractClaimKeys(fullEvidenceText);
    const replyKeys = extractClaimKeys(out);

    // Filter to high-signal quantitative claims
    const highSignalReplyClaims = replyKeys.filter(k => {
      if (k.kind === 'pct') return true;
      if (k.kind.startsWith('cur:')) return true;
      const numVal = parseFloat(k.value);
      if (k.unit !== '' && !TIME_UNITS.has(k.unit) && !Number.isNaN(numVal) && numVal >= 2) return true;
      return false;
    });

    const ungrounded: ClaimKey[] = [];
    const seenUngrounded = new Set<string>();

    for (const claim of highSignalReplyClaims) {
      // Check if kind + value matches any evidence key
      const matchesEvidenceKey = evidenceKeys.some(ek => {
        if (claim.kind === 'pct' && ek.kind === 'pct' && ek.value === claim.value) return true;
        if (claim.kind.startsWith('cur:') && ek.kind === claim.kind && ek.value === claim.value) return true;
        if (claim.unit && ek.unit === claim.unit && ek.value === claim.value) return true;
        return false;
      });

      // Also check if raw number string appears in evidence text
      const rawInEvidence = claim.raw.length >= 2 && fullEvidenceText.includes(claim.raw);

      if (!matchesEvidenceKey && !rawInEvidence) {
        // High-signal figures (especially pct or cur:*) must be grounded
        if (claim.kind === 'pct' || claim.kind.startsWith('cur:')) {
          if (!seenUngrounded.has(claim.raw)) {
            seenUngrounded.add(claim.raw);
            ungrounded.push(claim);
          }
        }
      }
    }

    if (ungrounded.length > 0) {
      out += `\n\n_Note: unverified figure in reply (${ungrounded.map(u => u.raw).join(', ')}) — not found in this run's tool results._`;
    }
  }

  return out;
}
