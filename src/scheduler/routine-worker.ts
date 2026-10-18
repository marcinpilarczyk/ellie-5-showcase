import { RoutineRepository, RoutineRecord } from '../storage/routine-repo.js';
import { UnifiedAgentRunner } from '../agent/runner.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { SlackCoworkerService } from '../integrations/slack/coworker.js';
import { lastFireTime, latestScheduledSlotAtOrBefore, zonedDateKey } from './cron.js';
import { UnifiedRunResult } from '../types/runner.js';
import { COMMAND_AND_CONTROL_TOOL_NAMES } from '../types/tool.js';
import { ModelTier } from '../models/model-router.js';

export { COMMAND_AND_CONTROL_TOOL_NAMES };

// Routines get real time to work; the wake unit allows 15 minutes per cycle.
export const ROUTINE_MAX_ROUNDS = 20;
export const ROUTINE_TIME_BUDGET_MS = 8 * 60_000;
export const ROUTINE_HARD_TIMEOUT_MS = 10 * 60_000;
/** A run claim older than this is a crashed run and may be taken over. */
export const ROUTINE_CLAIM_STALE_MS = ROUTINE_HARD_TIMEOUT_MS + 5 * 60_000;

/** Every routine can read stored results and skills, whatever its grant says. */
const ALWAYS_GRANTED = ['result_read', 'sheet_query', 'skills_list', 'skill_read'];
/** Research-and-report tools a routine gets when it was created without an explicit grant. */
export const DEFAULT_ROUTINE_GRANT = [
  'web_search', 'web_read_page', 'job_evaluate',
  'drive_search', 'drive_read_file',
  'docs_read', 'docs_create', 'docs_append', 'document_render', 'visual_document_render',
  'owner_sources_read', 'owner_text_check',
  'project_state_read', 'project_state_update',
  'waiting_list', 'waiting_track', 'waiting_resolve',
  'sheets_read', 'sheets_append', 'sheets_update',
  'gmail_search', 'gmail_read',
  'calendar_list',
  'delegate_subtask'
];

/** Routines that ask for the reasoning model ("reasoning", "pro") run on the ANALYSIS tier. */
export function tierForRoutine(routine: Pick<RoutineRecord, 'primary_model'>): ModelTier {
  return /reason|pro|argon/i.test(routine.primary_model || '') ? 'ANALYSIS' : 'ROUTINE';
}

export interface ResolvedGrant {
  tools: Set<string>;
  unavailable: string[];
}

export function resolveRoutineGrant(routine: RoutineRecord, toolExists: (name: string) => boolean): ResolvedGrant {
  let requested = DEFAULT_ROUTINE_GRANT;
  let isExplicit = false;
  if (routine.default_grant) {
    try {
      const parsed = JSON.parse(routine.default_grant);
      if (Array.isArray(parsed)) {
        requested = parsed;
        isExplicit = true;
      }
    } catch {}
  }

  const tools = new Set<string>(ALWAYS_GRANTED);
  const unavailable: string[] = [];
  for (const name of requested) {
    if (toolExists(name)) tools.add(name);
    else if (isExplicit) unavailable.push(name);
  }

  // SECURITY HARD GUARDRAIL: Strip any Command & Control tools from routine runs!
  for (const ctl of COMMAND_AND_CONTROL_TOOL_NAMES) {
    tools.delete(ctl);
  }
  return { tools, unavailable };
}

function parseList(json?: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function buildRoutineInstruction(routine: RoutineRecord, unavailable: string[], now = new Date()): string {
  const constraints = parseList(routine.hard_constraints);
  const rules = parseList(routine.rules);
  const silenceAllowed = Boolean(routine.allow_silence);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: routine.timezone || 'Europe/Warsaw' }).format(now);

  const sections = [
    `Scheduled routine "${routine.title}" (${today}, ${routine.timezone || 'Europe/Warsaw'}).`,
    routine.description ? `Purpose: ${routine.description}` : '',
    constraints.length ? `Task requirements (follow all of them):\n${constraints.map(c => `- ${c}`).join('\n')}` : '',
    rules.length ? `Rules:\n${rules.map(r => `- ${r}`).join('\n')}` : '',
    routine.destination ? `Destination: ${routine.destination}` : '',
    unavailable.length
      ? `These tools from the routine definition are not available, so work without them and mention it if it limits the result: ${unavailable.join(', ')}.`
      : '',
    [
      'Delivery: do the whole task now, then call finish.',
      'finish.message is what the owner reads in Slack: what you produced and the key findings in 2-6 sentences, with the link to any doc or sheet you created.',
      silenceAllowed
        ? 'If there is genuinely nothing new to report, finish with status NOTHING_TO_REPORT.'
        : 'This routine always reports, even when the result is short.',
      'If you could not complete the task, finish with status BLOCKED and say exactly what is missing.'
    ].join(' ')
  ];
  return sections.filter(Boolean).join('\n\n');
}

export type RoutineDeliveryStatus = 'DELIVERED' | 'SILENT' | 'FAILED' | 'NOT_DELIVERED';

export type RoutinePreFlightHook = (
  routine: RoutineRecord,
  context: { now: Date }
) => Promise<{ canSkip: boolean; reason?: string }>;

export class RoutineWorker {
  constructor(
    private readonly routineRepo: RoutineRepository,
    private readonly runner: UnifiedAgentRunner,
    private readonly ledgerRepo: ActionLedgerRepository,
    private readonly coworkerService?: SlackCoworkerService,
    private preFlightHook?: RoutinePreFlightHook
  ) {}

  private getDispatcher(): any {
    if (typeof (this.runner as any)?.getDispatcher === 'function') {
      return (this.runner as any).getDispatcher();
    }
    return (this.runner as any)?.dispatcher || (this.runner as any)?.['dispatcher'];
  }

  private getModelRouter(): any {
    if (typeof (this.runner as any)?.getModelRouter === 'function') {
      return (this.runner as any).getModelRouter();
    }
    return (this.runner as any)?.modelRouter || (this.runner as any)?.['modelRouter'];
  }

  public setPreFlightHook(hook: RoutinePreFlightHook): void {
    this.preFlightHook = hook;
  }

  public async runDueRoutines(now = new Date(), maxRoutinesPerCycle = 1): Promise<{ routinesRun: number; batchesStaged: number }> {
    const routines = this.routineRepo.getActiveRoutines();
    let routinesRun = 0;
    let batchesStaged = 0;

    for (const routine of routines) {
      if (routinesRun >= maxRoutinesPerCycle) {
        // Enforce max 1 due routine per wake cycle
        break;
      }

      // FIRST-BOOT STAMPEDE PREVENTION:
      // If a routine has never run before (last_run_at is null), initialize last_run_at to NOW
      // so it does not immediately trigger 10 routines back-to-back from historical crons.
      if (!routine.last_run_at) {
        this.routineRepo.updateLastRun(routine.id, now.toISOString());
        continue;
      }

      const tz = routine.timezone || 'Europe/Warsaw';
      let fireTime: Date | null = null;
      try {
        fireTime = latestScheduledSlotAtOrBefore(routine.cron_schedule, now, tz);
      } catch {
        continue;
      }

      if (!fireTime) continue;

      // Check if already executed at or after this scheduled slot
      if (routine.last_run_at) {
        const lastRunMs = new Date(routine.last_run_at).getTime();
        if (!Number.isNaN(lastRunMs) && lastRunMs >= fireTime.getTime()) {
          continue; // Already ran for this scheduled slot
        }
      }

      if (!this.claim(routine.id, now)) continue; // Already running (Run now, or another process)
      const res = await this.executeRoutine(routine, now);
      routinesRun++;
      if (res.stagedCount > 0) {
        batchesStaged++;
      }
    }

    return { routinesRun, batchesStaged };
  }

  public async runRoutineNow(routineId: string): Promise<{ routine: RoutineRecord; runResult: UnifiedRunResult; stagedCount: number; delivery: RoutineDeliveryStatus }> {
    const routine = this.routineRepo.getRoutine(routineId);
    if (!routine) {
      throw new Error(`Routine '${routineId}' not found.`);
    }

    const now = new Date();
    if (!this.claim(routine.id, now)) {
      throw new Error(`Routine '${routineId}' is already running.`);
    }
    const res = await this.executeRoutine(routine, now);
    return {
      routine: this.routineRepo.getRoutine(routineId)!,
      runResult: res.runResult,
      stagedCount: res.stagedCount,
      delivery: res.delivery
    };
  }

  /** Starts a routine without waiting for it; the result is delivered to Slack when it finishes. */
  public startRoutineNow(routineId: string): { started: boolean; alreadyRunning?: boolean; runningSince?: string; error?: string } {
    const routine = this.routineRepo.getRoutine(routineId);
    if (!routine) return { started: false, error: `Routine '${routineId}' not found.` };
    const now = new Date();
    if (!this.claim(routine.id, now)) {
      const runningSince = this.routineRepo.getRoutine(routineId)?.running_since || undefined;
      return { started: false, alreadyRunning: true, runningSince, error: `Routine '${routineId}' is already running (since ${runningSince}). Its result will be posted to Slack.` };
    }
    this.executeRoutine(routine, now).catch(err => {
      console.warn(`[RoutineWorker] Background run of ${routineId} failed:`, err.message);
    });
    return { started: true };
  }

  /** One run per routine at a time, across the server and the wake cycle (shared claim in the routines table). */
  private claim(routineId: string, now: Date): boolean {
    return this.routineRepo.claimRun(routineId, now.toISOString(), new Date(now.getTime() - ROUTINE_CLAIM_STALE_MS).toISOString());
  }

  /** Runs a routine the caller has claimed, and releases the claim however the run ends. */
  private async executeRoutine(
    routine: RoutineRecord,
    now: Date
  ): Promise<{ runResult: UnifiedRunResult; stagedCount: number; delivery: RoutineDeliveryStatus }> {
    try {
      if (this.preFlightHook && routine.allow_silence) {
        try {
          const check = await this.preFlightHook(routine, { now });
          if (check.canSkip) {
            const note = check.reason || 'Pre-flight check: underlying watched content unchanged';
            this.routineRepo.updateLastRun(routine.id, now.toISOString(), 'SILENT', undefined, note);
            const emptyResult: UnifiedRunResult = {
              runId: `skipped_${Date.now()}`,
              status: 'COMPLETED',
              output: {
                deliveryMode: 'SILENT',
                finishStatus: 'NOTHING_TO_REPORT',
                summary: note,
                coworkerHeadline: note
              },
              toolCallsExecuted: [],
              handlesCreated: [],
              telemetry: {
                promptTokens: 0,
                cachedTokens: 0,
                thinkingTokens: 0,
                candidatesTokens: 0,
                totalTokens: 0,
                model: this.getModelRouter()?.modelName || 'routine',
                durationMs: 0
              },
              wallMs: 0
            };
            return { runResult: emptyResult, stagedCount: 0, delivery: 'SILENT' };
          }
        } catch (err: any) {
          console.warn(`[RoutineWorker] Pre-flight check error for ${routine.id}:`, err.message);
        }
      }
      return await this.executeClaimed(routine, now);
    } finally {
      this.routineRepo.releaseRun(routine.id);
    }
  }

  private async executeClaimed(
    routine: RoutineRecord,
    now: Date
  ): Promise<{ runResult: UnifiedRunResult; stagedCount: number; delivery: RoutineDeliveryStatus }> {
    const tz = routine.timezone || 'Europe/Warsaw';
    const windowKey = zonedDateKey(now, tz);
    const batchId = `batch_${routine.id}_${windowKey.replace(/-/g, '')}`;

    const dispatcher = this.getDispatcher();
    const { tools: allowedTools, unavailable } = resolveRoutineGrant(routine, name => Boolean(dispatcher?.getTool(name)));
    if (unavailable.length > 0) {
      console.warn(`[RoutineWorker] Routine ${routine.id} grants tools that do not exist: ${unavailable.join(', ')}`);
    }

    const instruction = buildRoutineInstruction(routine, unavailable, now);

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), ROUTINE_HARD_TIMEOUT_MS);

    let runResult: UnifiedRunResult;
    try {
      runResult = await this.runner.run({
        trigger: 'routine',
        instruction,
        tier: tierForRoutine(routine),
        batchId,
        isInteractive: false,
        maxRounds: ROUTINE_MAX_ROUNDS,
        timeBudgetMs: ROUTINE_TIME_BUDGET_MS,
        abortSignal: abortController.signal,
        toolGrant: {
          allowedToolNames: allowedTools,
          allowConsequential: false // Background runs cannot execute consequential tools directly
        }
      });
    } catch (err: any) {
      console.warn(`[RoutineWorker] Error running routine ${routine.id}:`, err.message);
      await this.coworkerService?.postProactive(`⚠️ *${routine.title}* failed to run: ${err.message}`).catch(() => null);
      this.routineRepo.updateLastRun(routine.id, now.toISOString(), 'FAILED', undefined, err.message);
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    // Evaluator pass for routines with evaluator_model and hard_constraints
    if (runResult.status === 'COMPLETED' && runResult.output.finishStatus === 'DONE') {
      const constraints = parseList(routine.hard_constraints);
      if (routine.evaluator_model && routine.evaluator_model.trim().length > 0 && constraints.length > 0) {
        try {
          const evalPrompt = `You are Ellie's routine evaluator pass. Check whether the routine output and tool executions violated any hard constraints.

ROUTINE: "${routine.title}"
HARD CONSTRAINTS:
${constraints.map(c => `- ${c}`).join('\n')}

SLACK MESSAGE / HEADLINE:
${runResult.output.slackMessage || runResult.output.coworkerHeadline || ''}

EXECUTED TOOL CALLS:
${JSON.stringify(runResult.toolCallsExecuted.map(tc => ({ tool: tc.tool, params: tc.params })), null, 2)}

Respond with JSON ONLY:
{
  "passed": boolean,
  "violation": string (empty if passed, otherwise concise 1-sentence explanation of constraint violation)
}`;
          const router = this.getModelRouter();
          const evalResp = router ? await router.generate(evalPrompt, {
            tier: 'EVALUATOR',
            temperature: 0,
            responseMimeType: 'application/json',
            source: 'routine_evaluator'
          }) : null;

          if (evalResp?.text) {
            const parsed = JSON.parse(evalResp.text.trim());
            if (parsed && parsed.passed === false && parsed.violation) {
              const note = `\n_(Evaluator note: ${parsed.violation})_`;
              if (runResult.output.slackMessage) runResult.output.slackMessage += note;
              if (runResult.output.coworkerHeadline) runResult.output.coworkerHeadline += note;
            }
          }
        } catch (evalErr: any) {
          // Fail open on evaluator error
          console.warn(`[RoutineWorker] Evaluator pass failed for ${routine.id}:`, evalErr.message);
        }
      }
    }

    const stagedItems = this.ledgerRepo.listStaged(batchId);
    const delivery = await this.deliver(routine, runResult, stagedItems.length);

    if (stagedItems.length > 0 && this.coworkerService) {
      await this.coworkerService.notifyBatchStaged(batchId, stagedItems.length, routine.title).catch(() => {});
    }

    const note = unavailable.length ? `Missing tools: ${unavailable.join(', ')}` : undefined;
    this.routineRepo.updateLastRun(routine.id, now.toISOString(), delivery, runResult.runId, note);
    return { runResult, stagedCount: stagedItems.length, delivery };
  }

  /** Every run ends in Slack unless the routine explicitly allows silence and found nothing. */
  private async deliver(routine: RoutineRecord, run: UnifiedRunResult, stagedCount: number): Promise<RoutineDeliveryStatus> {
    const output = run.output;
    const failed = run.status !== 'COMPLETED';
    const nothingNew = output.finishStatus === 'NOTHING_TO_REPORT' || output.deliveryMode === 'SILENT';

    if (!failed && nothingNew && routine.allow_silence && stagedCount === 0) {
      return 'SILENT';
    }

    let body = (output.slackMessage || output.coworkerHeadline || '').trim();
    if (!body) body = nothingNew ? 'Nothing new to report.' : 'Finished without a summary. The trace is on the control page under Runs.';
    const link = output.artifactLink && !body.includes(output.artifactLink) ? `\n${output.artifactLink}` : '';
    const prefix = failed || output.finishStatus === 'BLOCKED' ? '⚠️ ' : '';
    const text = `${prefix}*${routine.title}*\n${body}${link}`;

    if (!this.coworkerService) return failed ? 'FAILED' : 'NOT_DELIVERED';
    const posted = await this.coworkerService.postProactive(text, run.runId).catch(err => ({ ok: false, ts: undefined, channel: undefined, error: err.message as string }));
    if (posted.ok && posted.ts && posted.channel) {
      // Replies to this post continue with the routine's evidence
      this.coworkerService.saveCarryover(posted.channel, posted.ts, run);
    }
    if (!posted.ok) {
      console.warn(`[RoutineWorker] Could not deliver ${routine.id} to Slack: ${posted.error}`);
      return 'NOT_DELIVERED';
    }
    return failed || output.finishStatus === 'BLOCKED' ? 'FAILED' : 'DELIVERED';
  }
}
