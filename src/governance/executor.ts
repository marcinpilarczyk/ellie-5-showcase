import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { WaitingRepository } from '../storage/waiting-repo.js';
import { ToolDispatcher } from './dispatcher.js';

export interface ExecutorDeps {
  ledgerRepo: ActionLedgerRepository;
  dispatcher: ToolDispatcher;
  actor?: string;
  waitingRepo?: WaitingRepository;
}

export interface ExecutionResult {
  ok: boolean;
  status: 'VERIFIED' | 'PROVIDER_CONFIRMED' | 'FAILED_SAFE' | 'RECONCILIATION_REQUIRED' | 'NOT_CLAIMABLE' | 'NOT_FOUND';
  message: string;
  result?: any;
}

const SEND_TOOLS = new Set(['gmail_send', 'proton_send']);

function recipients(to: unknown): string[] {
  return String(to ?? '')
    .split(/[,;]/)
    .map(r => (r.match(/<([^>]+)>/)?.[1] ?? r).trim().toLowerCase())
    .filter(Boolean);
}

/** ELLIE_SEND_ALLOWLIST: comma-separated addresses or @domains. Empty means no restriction. */
export function checkSendPolicy(actionType: string, payload: any, ledgerRepo: ActionLedgerRepository): string | null {
  if (!SEND_TOOLS.has(actionType)) return null;

  const allowlist = (process.env.ELLIE_SEND_ALLOWLIST || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length > 0) {
    const blocked = recipients(payload?.to).filter(addr =>
      !allowlist.some(entry => entry.startsWith('@') ? addr.endsWith(entry) : addr === entry)
    );
    if (blocked.length > 0) {
      return `Recipient not on ELLIE_SEND_ALLOWLIST: ${blocked.join(', ')}`;
    }
  }

  const maxDaily = parseInt(process.env.ELLIE_MAX_DAILY_SENDS || '', 10);
  if (Number.isFinite(maxDaily) && maxDaily > 0) {
    const sentToday = ledgerRepo.countExecutedSince([...SEND_TOOLS], new Date(Date.now() - 24 * 60 * 60 * 1000));
    if (sentToday >= maxDaily) {
      return `Daily send cap reached (${sentToday}/${maxDaily} in the last 24h, ELLIE_MAX_DAILY_SENDS).`;
    }
  }
  return null;
}

export async function executeApprovedAction(actionId: string, deps: ExecutorDeps): Promise<ExecutionResult> {
  const { ledgerRepo, dispatcher } = deps;
  const actor = deps.actor || 'owner';
  const record = ledgerRepo.get(actionId);

  if (!record) {
    return { ok: false, status: 'NOT_FOUND', message: `Action '${actionId}' not found.` };
  }

  if (record.state !== 'APPROVED' && record.state !== 'STAGED') {
    return {
      ok: false,
      status: 'NOT_CLAIMABLE',
      message: `Action '${actionId}' is already ${record.state.toLowerCase().replace(/_/g, ' ')}.`
    };
  }

  let payload: any = {};
  try {
    payload = JSON.parse(record.payload_json);
  } catch {
    return { ok: false, status: 'FAILED_SAFE', message: 'Malformed payload JSON' };
  }

  const type = record.action_type;

  // Policy checks happen before approval so a blocked action stays STAGED and editable.
  const policyError = checkSendPolicy(type, payload, ledgerRepo);
  if (policyError) {
    return { ok: false, status: 'FAILED_SAFE', message: policyError };
  }

  if (record.state === 'STAGED') {
    try {
      ledgerRepo.approveAction(actionId, actor);
    } catch (err: any) {
      return { ok: false, status: 'NOT_CLAIMABLE', message: err.message };
    }
  }

  const claimed = ledgerRepo.claimForExecution(actionId, 'executor');
  if (!claimed) {
    return {
      ok: false,
      status: 'NOT_CLAIMABLE',
      message: `Action '${actionId}' could not be claimed (already executing or settled).`
    };
  }

  try {
    const { result, readBack } = await dispatcher.executeApproved(type, payload, {
      runId: record.origin_run_id || `exec_${actionId}`,
      isInteractive: true,
      toolGrant: { allowedToolNames: new Set([type]), allowConsequential: true },
      batchId: record.batch_id || undefined
    });

    ledgerRepo.confirmProvider(actionId);

    if ((type === 'gmail_send' || type === 'proton_send') && deps.waitingRepo) {
      try {
        if (typeof payload?.to === 'string' && payload.to.trim() && typeof payload?.subject === 'string' && payload.subject.trim()) {
          const toList = recipients(payload.to);
          const primaryRecipient = toList[0];
          if (primaryRecipient) {
            const activeItems = deps.waitingRepo.list({ status: 'active', counterparty: primaryRecipient });
            const cleanedSubject = String(payload.subject).replace(/^Re:\s*/i, '').trim();
            const alreadyTracked = activeItems.some(item =>
              item.subject.replace(/^Re:\s*/i, '').trim().toLowerCase() === cleanedSubject.toLowerCase()
            );
            const combined = `${payload.subject}\n${payload.body || ''}`;
            const indicatesOpenLoop = combined.includes('?') || /\b(let me know|please confirm|looking forward|thoughts|feedback|when can|schedule|available|follow up|following up)\b/i.test(combined);
            if (!alreadyTracked && indicatesOpenLoop) {
              deps.waitingRepo.track({
                counterparty: primaryRecipient,
                subject: cleanedSubject,
                channel: type === 'proton_send' ? 'proton' : 'gmail',
                thread_ref: result?.threadId || payload?.threadId || null,
                due_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
              });
            }
          }
        }
      } catch {
        // waiting-repo error must never affect execution status
      }
    }

    // P7: a provider OK is not proof. Only a read-back makes it VERIFIED.
    if (!readBack) {
      return { ok: true, status: 'PROVIDER_CONFIRMED', message: describeResult(type, result), result };
    }
    if (readBack.status !== 'VERIFIED') {
      return { ok: true, status: 'PROVIDER_CONFIRMED', message: `Done, but not verified: ${readBack.detail}`, result };
    }
    ledgerRepo.markVerified(actionId);
    return { ok: true, status: 'VERIFIED', message: describeResult(type, result), result };
  } catch (err: any) {
    const message = err?.message || String(err);
    // Refusals and validation errors happen before anything leaves the building.
    if (/Refusal|Unsupported action type|ZodError|invalid_type/i.test(message) || err?.name === 'ZodError') {
      ledgerRepo.markFailedSafe(actionId, message);
      return { ok: false, status: 'FAILED_SAFE', message };
    }
    console.error(`[executeApprovedAction] Error executing ${actionId}:`, err);
    ledgerRepo.markReconciliationRequired(actionId, message);
    return { ok: false, status: 'RECONCILIATION_REQUIRED', message };
  }
}

function describeResult(type: string, res: any): string {
  if (type === 'gmail_send') return `Email sent via Gmail (ID: ${res?.messageId}).`;
  if (type === 'proton_send') return `Email sent via Proton (ID: ${res?.messageId}).`;
  if (type === 'gmail_draft') return `Draft created in Gmail (ID: ${res?.draftId}).`;
  if (type === 'calendar_create') return `Event created in Calendar (ID: ${res?.eventId}).`;
  if (type === 'sheets_append') return `Row appended to Sheet (${res?.updatedRange || 'done'}).`;
  if (type === 'sheets_update') return `Range updated in Sheet (${res?.updatedRange || 'done'}).`;
  if (type === 'composio_install_tool') {
    return res?.message || `Installed and set up Composio tool ${res?.toolSlug || ''} (${res?.registeredToolName || 'ready'}).`;
  }
  return `Executed ${type}.`;
}
