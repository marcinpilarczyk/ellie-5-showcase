import 'dotenv/config';
import { buildRuntime, Runtime } from './runtime/build-runtime.js';
import { buildQuoteCardBlocks } from './integrations/slack/cards.js';
import { reviewOwnerText } from './governance/claims-bank.js';

/**
 * One wake cycle, run by ellie-wake.timer every 15 minutes. Quick checks first so a long
 * routine never delays sentinels or reminders; at most one routine per cycle.
 */
async function main() {
  const startTime = Date.now();
  console.log(`[Ellie Wake] Cycle started at ${new Date().toISOString()}`);

  const runtime = buildRuntime();
  const { routineWorker, gmailSentinel, calendarSentinel, protonSentinel, reminderDispatcher, dbManager, ownerInventory, refreshOwnerInventory } = runtime;

  // Hard guard below the unit's TimeoutStartSec=15min; a routine gets up to 10 minutes
  const overallTimeout = setTimeout(() => {
    console.warn('[Ellie Wake] Overall hard timeout reached (14 min). Forcing exit.');
    try { dbManager.close(); } catch {}
    process.exit(0);
  }, 14 * 60_000);

  const step = async (label: string, fn: () => Promise<string | void>) => {
    try {
      const msg = await fn();
      if (msg) console.log(`[Ellie Wake] ${label}: ${msg}`);
    } catch (err: any) {
      console.warn(`[Ellie Wake] ${label} failed: ${err.message}`);
    }
  };

  try {
    await step('Gmail sentinel', async () => {
      const r = await gmailSentinel.runCheck();
      if (r.status === 'off') return 'off';
      if (r.status === 'not_connected') return 'not connected';
      if (r.status === 'error') return `error: ${r.error || 'check failed'}`;
      return r.cheapSkipped || r.status === 'unchanged' ? 'unchanged' : `${r.processedCount} processed, ${r.draftsStagedCount} drafts staged`;
    });
    await step('Calendar sentinel', async () => {
      const r = await calendarSentinel.runCheck();
      if (r.status === 'off') return 'off';
      if (r.status === 'not_connected') return 'not connected';
      if (r.status === 'error') return `error: ${r.error || 'check failed'}`;
      return r.cheapSkipped || r.status === 'unchanged' ? 'unchanged' : `${r.upcomingCount} upcoming meetings`;
    });
    await step('Proton sentinel', async () => {
      const r = await protonSentinel.runCheck();
      if (r.status === 'off') return 'off';
      if (r.status === 'not_connected') return 'not connected';
      if (r.status === 'error') return `error: ${r.error || 'check failed'}`;
      return r.cheapSkipped || r.status === 'unchanged' ? 'unchanged' : `${r.processedCount} processed`;
    });
    await step('Reminders', async () => {
      const n = await reminderDispatcher.dispatchDueReminders();
      return n > 0 ? `${n} delivered` : undefined;
    });
    await step('Waiting items', async () => {
      const nudgedCount = await processOverdueWaitingItems(runtime);
      return nudgedCount > 0 ? `${nudgedCount} overdue items nudged` : undefined;
    });
    await step('Storage maintenance', async () => {
      const n = runtime.resultStore.pruneOldResults(14);
      const prunedPrefs = runtime.memoryRepo.pruneStaleCandidates(30);
      const staleProposalsCleared = runtime.ledgerRepo.clearStale(24, 'wake_maintenance');
      const parts = [];
      if (n > 0) parts.push(`${n} expired results pruned`);
      if (prunedPrefs > 0) parts.push(`${prunedPrefs} stale candidates/facts pruned`);
      if (staleProposalsCleared > 0) parts.push(`${staleProposalsCleared} stale proposals cleared`);
      return parts.join(', ') || undefined;
    });
    await step('Owner Doc inventory', async () => {
      if (!ownerInventory.isDue()) return undefined;
      const r = await refreshOwnerInventory();
      return `${r.total} Docs: ${r.described} described, ${r.unchanged} unchanged, ${r.removed} removed, ${r.failed} failed`;
    });
    await step('Routines', async () => {
      const r = await routineWorker.runDueRoutines(new Date(), 1);
      return `${r.routinesRun} run, ${r.batchesStaged} batches staged`;
    });
  } finally {
    clearTimeout(overallTimeout);
    console.log(`[Ellie Wake] Cycle completed in ${Math.round((Date.now() - startTime) / 1000)}s.`);
    try { dbManager.close(); } catch {}
    process.exit(0);
  }
}

export async function processOverdueWaitingItems(runtime: {
  waitingRepo: Runtime['waitingRepo'];
  ledgerRepo: Runtime['ledgerRepo'];
  slackClient?: Runtime['slackClient'];
  nudgeGate?: Runtime['nudgeGate'];
  claimsGuard?: Runtime['claimsGuard'];
}): Promise<number> {
  const overdue = runtime.waitingRepo.list({ status: 'open', dueBefore: new Date().toISOString() });
  let nudgedCount = 0;

  for (const item of overdue.slice(0, 3)) {
    const emailMatch = item.counterparty.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    const channel = (item.channel || 'email').toLowerCase();
    const isEmailChannel = channel === 'email' || channel === 'gmail' || channel === 'proton';

    const evalFn = runtime.nudgeGate
      ? (typeof runtime.nudgeGate.evaluate === 'function'
          ? runtime.nudgeGate.evaluate.bind(runtime.nudgeGate)
          : runtime.nudgeGate.admit.bind(runtime.nudgeGate))
      : undefined;

    let stagedFollowup = false;

    if (emailMatch && isEmailChannel) {
      const extractedEmail = emailMatch[0];
      const subject = item.subject.startsWith('Re:') ? item.subject : `Re: ${item.subject}`;
      const ownerFirstName = process.env.ELLIE_OWNER_FIRST_NAME || process.env.ELLIE_OWNER_NAME || 'Owner';
      const body = `Hi,\n\nChecking in on ${item.subject} — please let me know if you need anything from my side.\n\nBest,\n${ownerFirstName}`;
      const payload: Record<string, any> = {
        to: extractedEmail,
        subject,
        body
      };
      if (item.thread_ref) {
        payload.threadId = item.thread_ref;
      }
      const actionType = channel === 'proton' ? 'proton_send' : 'gmail_send';

      let refusals: string[] = [];
      if (runtime.claimsGuard) {
        const review = await reviewOwnerText(
          runtime.claimsGuard,
          'message',
          `${payload.subject}\n${payload.body}`,
          { evidence: [item.counterparty, item.subject], identity: false }
        );
        refusals = review.refusals;
      }

      if (refusals.length === 0) {
        const text = `⏰ *Waiting-on overdue:* follow-up draft for ${item.counterparty} — *${item.subject}*`;
        const admission = evalFn
          ? evalFn({
              source: 'waiting_overdue',
              priority: 'normal',
              text,
              dedupeKey: `waiting_overdue:${item.id}`
            })
          : { decision: { action: 'SEND' } };

        if (admission.decision.action === 'SEND') {
          runtime.waitingRepo.nudge(item.id);
          const baseActionId = `followup_${item.id}`;
          const actionId = runtime.ledgerRepo.get(baseActionId)
            ? `${baseActionId}_${Date.now()}`
            : baseActionId;
          runtime.ledgerRepo.stageProposal({ actionId, actionType, payload });

          if (runtime.slackClient) {
            const blocks = buildQuoteCardBlocks(actionId, actionType, payload);
            const posted = await runtime.slackClient.postMessage({
              channel: runtime.slackClient.defaultChannel,
              text,
              blocks
            });
            if (posted?.ts) {
              runtime.ledgerRepo.updateSlackCardTs(actionId, posted.ts);
            }
          }
          nudgedCount++;
        }
        stagedFollowup = true;
      }
    }

    if (!stagedFollowup) {
      const text = `⏰ *Waiting-on overdue:* ${item.counterparty} — *${item.subject}* (due ${item.due_at}). Reply in Slack if you want me to send a follow-up.`;
      const admission = evalFn
        ? evalFn({
            source: 'waiting_overdue',
            priority: 'normal',
            text,
            dedupeKey: `waiting_overdue:${item.id}`
          })
        : { decision: { action: 'SEND' } };

      if (admission.decision.action === 'SEND') {
        runtime.waitingRepo.nudge(item.id);
        if (runtime.slackClient) {
          await runtime.slackClient.postMessage({
            channel: runtime.slackClient.defaultChannel,
            text
          });
        }
        nudgedCount++;
      }
    }
  }

  return nudgedCount;
}

const isDirectRun = Boolean(
  process.argv[1] &&
  (process.argv[1].replace(/\\/g, '/').endsWith('wake.js') || process.argv[1].replace(/\\/g, '/').endsWith('wake.ts'))
);

if (isDirectRun) {
  main().catch(err => {
    console.error('[Ellie Wake] Fatal error:', err);
    process.exit(1);
  });
}
