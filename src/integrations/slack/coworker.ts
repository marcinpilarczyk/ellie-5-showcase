import { SlackClient } from './client.js';
import { explicitReasoningRequest } from '../../models/model-router.js';
import { ActionLedgerRepository } from '../../storage/action-ledger.js';
import { UnifiedAgentRunner, isUserQuestionOrPing, stoppedEarlyMessage } from '../../agent/runner.js';
import { buildQuoteCardBlocks, buildSettledCardBlocks, SettledCardState } from './cards.js';
import { UnifiedRunResult } from '../../types/runner.js';
import type { ExecutionResult } from '../../governance/executor.js';
import { stripRepeatedHeaders } from '../../governance/dispatcher.js';
import { reviewOwnerText } from '../../governance/claims-bank.js';
import { ThreadCarryoverRepository } from '../../storage/thread-carryover-repo.js';
import type { ResultStore } from '../../storage/result-store.js';
import type { RunTraceStore } from '../../storage/run-trace-store.js';
import type { MemoryRepository } from '../../storage/memory-repo.js';
import { extractCorrectionLesson } from '../../agent/correction-extractor.js';
import { COMMAND_AND_CONTROL_TOOL_NAMES } from '../../types/tool.js';
import { extractFileContent } from './file-parser.js';

export type ApprovedActionExecutor = (actionId: string, actor: string) => Promise<ExecutionResult>;

export const CORE_INTERACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'calendar_list',
  'calendar_create',
  'calendar_get_event',
  'gmail_get_thread',
  'gmail_search',
  'gmail_draft',
  'gmail_send',
  'proton_list_unread',
  'proton_read_message',
  'proton_draft',
  'proton_send',
  'web_search',
  'web_read_page',
  'waiting_track',
  'waiting_list',
  'waiting_resolve',
  'project_state_update',
  'project_state_read',
  'space_publish',
  'space_list',
  'memory_manage',
  'result_read',
  'result_search',
  'delegate_subtask'
]);

export const DOCUMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'document_render',
  'visual_document_render',
  'owner_sources_read',
  'owner_text_check',
  'docs_create',
  'docs_append',
  'docs_read',
  'drive_search',
  'drive_read_file',
  'sheets_read',
  'sheets_append',
  'sheets_update',
  'sheet_query',
  'job_evaluate'
]);

export const IMAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'image_generate',
  'image_edit',
  'image_describe'
]);

export const MANAGEMENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'routine_manage',
  'reminder_manage',
  'nudge_settings_manage',
  'queue_manage',
  'workspace_alias_manage',
  'sentinel_manage',
  'cost_and_budget_manage'
]);

export const DIAGNOSTIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'trace_inspect_recent',
  'trace_inspect_run',
  'repo_list_and_search',
  'repo_read_file',
  'vps_inspect'
]);

export const COMPOSIO_TOOL_NAMES: ReadonlySet<string> = new Set([
  'composio_search_free_tools',
  'composio_install_tool',
  'composio_setup_tool',
  'composio_execute_tool'
]);

export const SLACK_WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'slack_search',
  'slack_read_channel',
  'slack_read_thread',
  'slack_canvas_create',
  'slack_canvas_update',
  'slack_post_message'
]);

export const ALL_KNOWN_PRODUCTION_TOOLS: ReadonlySet<string> = new Set([
  ...CORE_INTERACTIVE_TOOL_NAMES,
  ...DOCUMENT_TOOL_NAMES,
  ...IMAGE_TOOL_NAMES,
  ...MANAGEMENT_TOOL_NAMES,
  ...DIAGNOSTIC_TOOL_NAMES,
  ...COMPOSIO_TOOL_NAMES,
  ...SLACK_WORKSPACE_TOOL_NAMES
]);

export interface InteractiveGrantOptions {
  userText: string;
  conversationHistory?: Array<{ role: string; parts: any[] }>;
  allAvailableTools: Set<string> | string[];
  hasAttachedImages?: boolean;
}

/**
 * Resolves a tailored, scoped per-run tool grant for an interactive Slack turn (P4).
 * Prevents model confusion and prompt bloat by granting only relevant capability clusters
 * while keeping core Chief of Staff tools always available.
 */
export function resolveInteractiveSlackGrant(options: InteractiveGrantOptions): Set<string> {
  const available = new Set(options.allAvailableTools);
  const text = (options.userText || '').toLowerCase();
  const historyText = (options.conversationHistory || [])
    .flatMap(turn => (turn.parts || []).map((p: any) => (typeof p?.text === 'string' ? p.text : '')))
    .join(' ')
    .toLowerCase();
  const combinedText = `${text} ${historyText}`;

  // Explicit override: if user asks for /all-tools, grant everything
  if (/^\/all-tools\b/i.test(text.trim())) {
    return new Set(available);
  }

  const granted = new Set<string>();

  // 1. Core tools are always granted
  for (const name of CORE_INTERACTIVE_TOOL_NAMES) {
    if (available.has(name)) granted.add(name);
  }

  // 2. Documents / Drive / Sheets / Resume / Job Evaluation
  const wantsDocuments = /\b(resume|cv|cover\s*letter|memo|brief|one[- ]pager|pitch[- ]sheet|infographic|document|doc|docx|pdf|write|draft|format|tailor|drive|folder|sheet|spreadsheet|job|apply|posting|hiring|role|evaluation|jev|xlsx|xls|csv)\b/i.test(combinedText);
  if (wantsDocuments) {
    for (const name of DOCUMENT_TOOL_NAMES) {
      if (available.has(name)) granted.add(name);
    }
  }

  // 3. Images / Visual concept generation
  const wantsImages = Boolean(options.hasAttachedImages) || /\b(image|picture|photo|illustration|draw|generate\s+image|edit\s+image|banana|visual\s+concept|mockup|banner|avatar)\b/i.test(combinedText);
  if (wantsImages) {
    for (const name of IMAGE_TOOL_NAMES) {
      if (available.has(name)) granted.add(name);
    }
  }

  // 4. Management & Admin (Routines, Reminders, Nudges, Costs, Queue, Sentinels, Recurring Schedules)
  const wantsManagement = /\b(routine|cron|schedule|scheduled|reminder|nudge|quiet|snooze|budget|cost|spend|spending|queue|approval|alias|sentinel|token|every\s+(weekday|day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|morning|evening|night|hour)|\d{1,2}:\d{2})\b/i.test(combinedText);
  if (wantsManagement) {
    for (const name of MANAGEMENT_TOOL_NAMES) {
      if (available.has(name)) granted.add(name);
    }
  }

  // 5. Diagnostics & Debugging (Traces, Repo code, VPS, Errors)
  const wantsDiagnostics = /\b(trace|inspect|diagnos|debug|error|fail|crash|bug|why\s+did|repo|code|log|logs|vps|systemctl|service|memory\s+leak|hanging|stuck)\b/i.test(combinedText);
  if (wantsDiagnostics) {
    for (const name of DIAGNOSTIC_TOOL_NAMES) {
      if (available.has(name)) granted.add(name);
    }
  }

  // 6. Composio & External integrations
  const wantsComposio = /\b(composio|integration|external\s+tool|find\s+tool|install\s+tool|github|linear|notion|trello|jira|airtable|hubspot|asana)\b/i.test(combinedText);
  if (wantsComposio) {
    for (const name of COMPOSIO_TOOL_NAMES) {
      if (available.has(name)) granted.add(name);
    }
    for (const name of available) {
      if (name.startsWith('composio_')) {
        granted.add(name);
      }
    }
  }

  // 7. Slack Workspace & Canvases
  const wantsSlackWorkspace = /\b(slack|channel|canvas|canvases|thread|workspace|post\s+to|send\s+to\s+#|announcement)\b/i.test(combinedText);
  if (wantsSlackWorkspace) {
    for (const name of SLACK_WORKSPACE_TOOL_NAMES) {
      if (available.has(name)) granted.add(name);
    }
  }

  // 8. Custom / test mock tools outside known production clusters are always passed through
  for (const name of available) {
    if (!ALL_KNOWN_PRODUCTION_TOOLS.has(name) && !name.startsWith('composio_')) {
      granted.add(name);
    }
  }

  // Safety fallback: if no tools were granted, fallback to available
  if (granted.size === 0) {
    return new Set(available);
  }

  return granted;
}

// Interactive budgets: the model gets ~4.5 minutes of work, then must finish; hard stop at 6.
export const INTERACTIVE_MAX_ROUNDS = 25;
export const INTERACTIVE_TIME_BUDGET_MS = 270_000;
export const INTERACTIVE_HARD_TIMEOUT_MS = 360_000;
const STATUS_DELAY_MS = 4000;
const STATUS_MIN_INTERVAL_MS = 2500;

const STEP_LABELS: Array<[RegExp, string]> = [
  [/^web_search/, 'Searching the web'],
  [/^web_read/, 'Reading a web page'],
  [/^delegate_subtask/, 'Running delegated subtask'],
  [/document_render/, 'Rendering the document'],
  [/docs_create/, 'Writing the Google Doc'],
  [/docs_append/, 'Updating the Google Doc'],
  [/docs_read/, 'Reading a Google Doc'],
  [/sheets_append/, 'Adding a row to the sheet'],
  [/sheets_update/, 'Updating the sheet'],
  [/sheets_read|sheet_query/, 'Reading the sheet'],
  [/drive_search/, 'Searching Drive'],
  [/gmail_send|proton_send|gmail_draft/, 'Preparing the email'],
  [/^gmail_|^proton_/, 'Checking email'],
  [/calendar/, 'Checking the calendar'],
  [/linkedin/, 'Looking at LinkedIn'],
  [/result_read/, 'Reading earlier results'],
  [/skill/, 'Loading a skill'],
  [/memory/, 'Checking memory'],
  [/^composio_search/, 'Checking Composio for a free tool'],
  [/^composio_install/, 'Proposing Composio tool installation'],
  [/^composio_setup/, 'Setting up Composio tool'],
  [/^composio_/, 'Running Composio tool'],
  [/^slack_search/, 'Searching Slack workspace'],
  [/^slack_read_channel/, 'Reading Slack channel'],
  [/^slack_read_thread/, 'Reading Slack thread'],
  [/^slack_canvas_/, 'Updating Slack Canvas'],
  [/^slack_post_message/, 'Preparing Slack message'],
  [/trace_|repo_/, 'Inspecting my own traces']
];

export function stepLabel(toolName: string): string {
  return STEP_LABELS.find(([re]) => re.test(toolName))?.[1] ?? `Running ${toolName}`;
}

/**
 * Status reporter supporting modern Slack agent streaming with plan mode,
 * with seamless fallback to classic in-place message updates.
 */
export class SlackStatusReporter {
  private ts?: string;
  private streamTs?: string;
  private streamingMode = false;
  private activeTaskId?: string;
  private steps = 0;
  private label = 'Working on it';
  private chain: Promise<void> = Promise.resolve();
  private lastPush = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private done = false;

  constructor(
    private readonly slackClient: SlackClient,
    private readonly channel: string,
    private readonly threadTs: string,
    private readonly delayMs = STATUS_DELAY_MS
  ) {}

  public async initStream(): Promise<boolean> {
    try {
      if (typeof this.slackClient.startStream === 'function') {
        const res: any = await this.slackClient.startStream({
          channel: this.channel,
          thread_ts: this.threadTs,
          task_display_mode: 'plan'
        });
        if (res?.ok && res?.ts) {
          this.streamTs = res.ts;
          this.streamingMode = true;
          return true;
        }
      }
    } catch {}
    return false;
  }

  public isStreaming(): boolean {
    return this.streamingMode;
  }

  public step(toolName: string): void {
    if (this.done) return;
    this.steps++;
    const label = stepLabel(toolName);
    this.label = label;
    const taskId = `task_${this.steps}_${toolName.replace(/[^\w-]/g, '_')}`;

    if (this.streamingMode && this.streamTs) {
      this.chain = this.chain.then(async () => {
        const chunks: any[] = [];
        if (this.activeTaskId) {
          chunks.push({ type: 'task', id: this.activeTaskId, status: 'complete' });
        }
        chunks.push({ type: 'task', id: taskId, text: label, status: 'in_progress' });
        this.activeTaskId = taskId;
        await this.slackClient.appendStream({
          channel: this.channel,
          ts: this.streamTs!,
          chunks
        }).catch(() => {});
      }).catch(() => {});
      return;
    }

    if (this.ts) {
      this.push();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.push(true), this.delayMs);
      this.timer.unref?.();
    }
  }

  private push(force = false): void {
    if (this.done) return;
    const now = Date.now();
    if (!force && now - this.lastPush < STATUS_MIN_INTERVAL_MS) return;
    this.lastPush = now;
    const text = `⏳ ${this.label}… (step ${this.steps})`;
    this.chain = this.chain.then(async () => {
      if (this.done && this.ts) return;
      if (!this.ts) {
        const res: any = await this.slackClient.postMessage({ channel: this.channel, text, thread_ts: this.threadTs });
        if (res?.ts) this.ts = res.ts;
      } else {
        await this.slackClient.updateMessage({ channel: this.channel, ts: this.ts, text });
      }
    }).catch(() => {});
  }

  /** Replaces the status message with the final text or stops stream. Returns false if no status message exists. */
  public async finish(text: string, sessionStatus: 'active' | 'suspended' | 'closed' = 'active'): Promise<boolean> {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    await this.chain;

    if (this.streamingMode && this.streamTs) {
      try {
        const finalChunks: any[] = [];
        if (this.activeTaskId) {
          finalChunks.push({ type: 'task', id: this.activeTaskId, status: 'complete' });
        }
        await this.slackClient.appendStream({
          channel: this.channel,
          ts: this.streamTs,
          chunks: finalChunks
        }).catch(() => {});

        const res: any = await this.slackClient.stopStream({
          channel: this.channel,
          ts: this.streamTs,
          markdown_text: text,
          session_status: sessionStatus
        });
        return res ? res.ok !== false : true;
      } catch {}
    }

    if (!this.ts) return false;
    const res: any = await this.slackClient.updateMessage({ channel: this.channel, ts: this.ts, text }).catch(() => null);
    return res ? res.ok !== false : false;
  }
}

export interface SlackEventPayload {
  type: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  channel: string;
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    url_private_download?: string;
    url_private?: string;
  }>;
}

export class SlackCoworkerService {
  constructor(
    private readonly slackClient: SlackClient,
    private readonly ledgerRepo: ActionLedgerRepository,
    private readonly runner: UnifiedAgentRunner,
    // Control page links point at the tailnet address when set; the public (Funnel) URL only exposes webhooks
    private readonly missionControlUrl = process.env.ELLIE_CONTROL_URL || process.env.ELLIE_PUBLIC_URL || 'http://127.0.0.1:3001',
    private readonly executeAction?: ApprovedActionExecutor,
    private readonly carryover?: ThreadCarryoverRepository,
    private readonly traces?: RunTraceStore,
    private readonly memoryRepo?: MemoryRepository,
    private readonly resultStore?: ResultStore
  ) {}

  private getResultStore(): ResultStore | undefined {
    if (this.resultStore) return this.resultStore;
    const dispatcher = this.getDispatcher();
    if (dispatcher && typeof dispatcher.getResultStore === 'function') {
      return dispatcher.getResultStore();
    }
    if (this.carryover && typeof (this.carryover as any).getResultStore === 'function') {
      return (this.carryover as any).getResultStore();
    }
    return undefined;
  }

  /** Every delivery is written to its run trace; a trace write never blocks the reply. */
  private recordDelivered(runId: string | undefined, text: string): void {
    if (!runId) return;
    try {
      this.traces?.recordDelivered(runId, text);
    } catch {}
  }

  private readonly threadQueues = new Map<string, Promise<void>>();
  private readonly backgroundAbortControllers = new Map<string, AbortController>();
  private readonly activeRunAbortControllers = new Map<string, AbortController>();
  private readonly userActiveContext = new Map<string, any>();
  private readonly imageCache = new Map<string, { mimeType: string; data: string }>();
  private readonly fileCache = new Map<string, { buffer: Buffer; mimeType?: string }>();

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

  /** Messages in the same thread run one at a time, in order; other threads run in parallel. */
  public async handleUserMessage(event: SlackEventPayload): Promise<void> {
    const threadTs = event.thread_ts || event.ts;
    const threadKey = `${event.channel}:${threadTs}`;

    const existingAbort = this.backgroundAbortControllers.get(threadKey);
    if (existingAbort) {
      existingAbort.abort();
      this.backgroundAbortControllers.delete(threadKey);
    }

    const previous = this.threadQueues.get(threadKey) ?? Promise.resolve();
    let backgroundTask: (() => Promise<void>) | undefined;

    const interactivePhase = previous.catch(() => {}).then(async () => {
      const res = await this.processUserMessage(event);
      backgroundTask = res?.backgroundTask;
    });

    const tracked = interactivePhase.catch(() => {}).finally(() => {
      if (this.threadQueues.get(threadKey) === tracked) this.threadQueues.delete(threadKey);
    });
    this.threadQueues.set(threadKey, tracked);

    await interactivePhase;

    if (backgroundTask) {
      await backgroundTask();
    }
  }

  private async processUserMessage(event: SlackEventPayload): Promise<{ backgroundTask?: () => Promise<void> } | void> {
    const threadTs = event.thread_ts || event.ts;
    const threadKey = `${event.channel}:${threadTs}`;
    const isThreadReply = Boolean(event.thread_ts);
    const cleanCurrentText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const userText = cleanCurrentText || event.text;
    const wantsReasoning = /^\/argon\b/i.test(userText.trim()) || explicitReasoningRequest(userText);
    const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // 1. Acknowledge, load thread history (with recent thread images/files) and download current images and files in parallel
    const [, threadContext, currentImageParts, attachedFileParts] = await Promise.all([
      this.slackClient.addReaction({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {}),
      isThreadReply ? this.loadThreadHistoryWithImages(event, threadTs, runId) : Promise.resolve({ history: [], threadImages: [] }),
      this.downloadImages(event),
      this.downloadAndExtractFiles(event, threadKey, runId)
    ]);
    const conversationHistory = threadContext.history;

    // Set Slack Agent session status to processing
    if (typeof this.slackClient.setSessionStatus === 'function') {
      await this.slackClient.setSessionStatus({
        channel: event.channel,
        thread_ts: threadTs,
        status: 'processing'
      }).catch(() => {});
    }

    // Auto-rename agent session on initial turn if this is the start of a thread
    if (!isThreadReply && cleanCurrentText && typeof this.slackClient.renameSession === 'function') {
      const titleCandidate = cleanCurrentText.split('\n')[0].trim();
      const shortTitle = titleCandidate.length > 40 ? titleCandidate.substring(0, 37) + '...' : titleCandidate;
      this.slackClient.renameSession({
        channel: event.channel,
        thread_ts: threadTs,
        title: shortTitle
      }).catch(() => {});
    }

    // Per-run explicit tool grant for Slack (P4)
    const allAvailable = (this.getDispatcher()?.getAllTools?.() || []).map((t: any) => t.name);
    const hasAttachedImages = (event.files?.length ?? 0) > 0 || currentImageParts.length > 0;
    const attachedFileNames = (event.files || []).map(f => f.name || '').filter(Boolean).join(' ');
    const interactiveSlackGrant = resolveInteractiveSlackGrant({
      userText: attachedFileNames ? `${userText} ${attachedFileNames}` : userText,
      conversationHistory,
      allAvailableTools: allAvailable,
      hasAttachedImages
    });

    // Pre-warm interactive cache immediately using the exact scoped per-run tool grant
    try {
      this.runner.warmInteractiveCache?.({ allowedToolNames: interactiveSlackGrant, allowConsequential: true }, wantsReasoning ? 'ANALYSIS' : 'INTERACTIVE');
    } catch {}

    // Combine images: conversationHistory already has prior thread images attached to their respective turns.
    // userParts only takes currentImageParts (unless history is empty and fallback thread images exist).
    const MAX_THREAD_IMAGES = 4;
    const imageParts = (conversationHistory.length > 0
      ? currentImageParts
      : [...currentImageParts, ...threadContext.threadImages]
    ).slice(0, MAX_THREAD_IMAGES);

    // 2. A non-question reply in a thread with a staged action revises that action
    if (isThreadReply && !isUserQuestionOrPing(cleanCurrentText)) {
      const stagedAction = this.ledgerRepo.getLatestStagedByThreadTs(threadTs);
      if (stagedAction) {
        const applied = await this.handleInThreadRevision(stagedAction, event);
        await this.slackClient.removeReaction({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
        if (applied) {
          await this.slackClient.addReaction({ channel: event.channel, timestamp: event.ts, name: 'white_check_mark' }).catch(() => {});
        }
        return;
      }
    }

    const userParts: any[] = [];
    if (cleanCurrentText) {
      userParts.push({ text: cleanCurrentText });
    }

    // Active view context from app_context_changed
    const activeContext = this.userActiveContext.get(event.user);
    if (activeContext && (activeContext.channel_id || activeContext.entity_id || activeContext.entity_type)) {
      const ctxParts: string[] = [];
      if (activeContext.channel_id) ctxParts.push(`channel: <#${activeContext.channel_id}>`);
      if (activeContext.thread_ts) ctxParts.push(`thread_ts: ${activeContext.thread_ts}`);
      if (activeContext.entity_type) ctxParts.push(`type: ${activeContext.entity_type}`);
      if (activeContext.entity_id) ctxParts.push(`id: ${activeContext.entity_id}`);
      userParts.push({
        text: `[User Active Slack View Context: User currently has active focus on ${ctxParts.join(', ')}. Use this context if their prompt refers to 'this channel', 'this thread', 'this canvas', or current view.]`
      });
    }

    const earlierWork = isThreadReply ? this.carryover?.get(threadKey) : null;
    const inlined = earlierWork ? (this.carryover?.inlineResults(threadKey) ?? []) : [];
    if (earlierWork) {
      userParts.push({ text: `[Context: what your earlier work in this thread found. Build on it instead of redoing it: reopen any item with result_read and its handle. If something you need is not listed here or in the thread, read it again from its source or ask; never search old run traces for it.]\n${earlierWork}` });
    }
    if (inlined.length > 0) {
      // Short carried results in full: no result_read round needed for them
      userParts.push({ text: `[Full text of the shorter items above; do not result_read these handles again.]\n${inlined.map(i => `--- ${i.tool}(${i.params}) [handle ${i.handle}]\n${i.text}`).join('\n')}` });
    }
    userParts.push(...attachedFileParts);
    userParts.push(...imageParts);
    if (userParts.length === 0) {
      userParts.push({ text: event.text });
    }

    // 3. Normal interactive turn execution via UnifiedAgentRunner (INTERACTIVE_SLACK)
    const status = new SlackStatusReporter(this.slackClient, event.channel, threadTs);
    await status.initStream().catch(() => {});

    const hardStop = new AbortController();
    this.activeRunAbortControllers.set(threadKey, hardStop);
    const hardStopTimer = setTimeout(() => hardStop.abort(), INTERACTIVE_HARD_TIMEOUT_MS);
    hardStopTimer.unref?.();

    const effectiveInstruction = userText || (attachedFileParts.length > 0 ? 'Please inspect and process the attached file(s).' : event.text);
    let runResult: UnifiedRunResult;
    try {
      runResult = await this.runner.run({
      runId,
      trigger: 'slack_dm',
      instruction: effectiveInstruction,
      userParts,
      conversationHistory,
      inlinedHandles: inlined.map(i => i.handle),
      tier: wantsReasoning ? 'ANALYSIS' : 'INTERACTIVE',
      isInteractive: true,
      maxRounds: INTERACTIVE_MAX_ROUNDS,
      timeBudgetMs: INTERACTIVE_TIME_BUDGET_MS,
      abortSignal: hardStop.signal,
      onToolStart: tool => status.step(tool),
      toolGrant: {
        allowedToolNames: interactiveSlackGrant,
        allowConsequential: true
      },
      slackOrigin: {
        channel: event.channel,
        threadTs,
        user: event.user,
        isDirectMessage: true
      }
    });
    } finally {
      clearTimeout(hardStopTimer);
      if (this.activeRunAbortControllers.get(threadKey) === hardStop) {
        this.activeRunAbortControllers.delete(threadKey);
      }
    }

    try {
      this.carryover?.save(threadKey, runResult);
    } catch (err: any) {
      console.warn('[SlackCoworkerService] Failed to save thread carryover:', err.message);
    }

    // 4. Deliver response according to Viktor-style coworker UX
    await this.deliverResult(event, runResult, threadTs, status);

    // 5. If the run requested background continuation or timed out with unfinished work, prepare background task
    let backgroundTask: (() => Promise<void>) | undefined;
    if (this.shouldContinueInBackground(runResult)) {
      const abortCtrl = new AbortController();
      this.backgroundAbortControllers.set(threadKey, abortCtrl);
      backgroundTask = async () => {
        try {
          await this.runBackgroundContinuation(event, runResult, threadTs, userText, conversationHistory, abortCtrl.signal);
        } catch (err: any) {
          console.error('[SlackCoworkerService] Background continuation error:', err);
        } finally {
          if (this.backgroundAbortControllers.get(threadKey) === abortCtrl) {
            this.backgroundAbortControllers.delete(threadKey);
          }
        }
      };
    }

    return { backgroundTask };
  }

  public shouldContinueInBackground(runResult: UnifiedRunResult): boolean {
    if (runResult.output.finishStatus === 'CONTINUE_IN_BACKGROUND') return true;
    if (runResult.status === 'TIMEOUT') return true;
    if (runResult.output.finishStatus === 'BLOCKED') {
      const msg = (runResult.output.slackMessage || runResult.output.coworkerHeadline || '').toLowerCase();
      if (msg.includes('continue') || msg.includes('ran out of time') || msg.includes('background')) {
        return true;
      }
    }
    return false;
  }

  public async runBackgroundContinuation(
    event: SlackEventPayload,
    initialResult: UnifiedRunResult,
    threadTs: string,
    userText: string,
    conversationHistory: Array<{ role: 'user' | 'model'; parts: any[] }>,
    signal?: AbortSignal
  ): Promise<UnifiedRunResult | null> {
    const threadKey = `${event.channel}:${threadTs}`;
    const allTools: string[] = (this.getDispatcher()?.getAllTools?.() || []).map((t: any) => t.name);
    // Continuation grant: strip Command & Control tools (P6: background cannot change config/routines)
    const continuationGrant = new Set<string>(
      allTools.filter((t: string) => !COMMAND_AND_CONTROL_TOOL_NAMES.has(t))
    );

    await this.slackClient.addReaction({ channel: event.channel, timestamp: threadTs, name: 'hourglass_flowing_sand' }).catch(() => {});

    const priorSummary = initialResult.output.slackMessage || initialResult.output.coworkerHeadline || initialResult.output.summary || '';
    const continuationParts = [
      { text: `[BACKGROUND CONTINUATION: You are continuing this task autonomously in the background until it is fully finished. Initial progress / status: "${priorSummary}". Build on the tool results and handles already created and drive the task to complete delivery. When completely finished, call finish with status DONE.]` }
    ];

    const continuationRunId = `cont_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const continuationResult = await this.runner.run({
      runId: continuationRunId,
      trigger: 'background_continuation',
      instruction: userText,
      userParts: continuationParts,
      conversationHistory,
      inlinedHandles: initialResult.handlesCreated,
      tier: 'INTERACTIVE',
      isInteractive: false,
      batchId: `continuation_${initialResult.runId}`,
      maxRounds: 20,
      timeBudgetMs: 600_000,
      abortSignal: signal,
      toolGrant: {
        allowedToolNames: continuationGrant,
        allowConsequential: true
      },
      slackOrigin: {
        channel: event.channel,
        threadTs,
        user: event.user,
        isDirectMessage: true
      }
    });

    await this.slackClient.removeReaction({ channel: event.channel, timestamp: threadTs, name: 'hourglass_flowing_sand' }).catch(() => {});

    if (signal?.aborted) {
      return null;
    }

    try {
      this.carryover?.save(threadKey, continuationResult);
    } catch (err: any) {
      console.warn('[SlackCoworkerService] Failed to save continuation carryover:', err.message);
    }

    if (signal?.aborted) {
      return null;
    }

    await this.deliverResult(event, continuationResult, threadTs);
    return continuationResult;
  }

  /** Proactive root message (routines). Returns the message ts so replies become a thread. */
  public async postProactive(text: string, runId?: string): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }> {
    if (!this.slackClient.isConfigured()) return { ok: false, error: 'Slack is not configured' };
    const res: any = await this.slackClient.postMessage({ channel: this.slackClient.defaultChannel, text });
    if (res?.ok) this.recordDelivered(runId, text);
    return { ok: Boolean(res?.ok), ts: res?.ts, channel: res?.channel || this.slackClient.defaultChannel, error: res?.error };
  }

  public saveCarryover(channel: string, threadTs: string, run: UnifiedRunResult): void {
    try {
      this.carryover?.save(`${channel}:${threadTs}`, run);
    } catch {}
  }

  private async loadThreadHistory(event: SlackEventPayload, threadTs: string, runId?: string): Promise<Array<{ role: 'user' | 'model'; parts: any[] }>> {
    const { history } = await this.loadThreadHistoryWithImages(event, threadTs, runId);
    return history;
  }

  private async loadThreadHistoryWithImages(
    event: SlackEventPayload,
    threadTs: string,
    runId?: string
  ): Promise<{ history: Array<{ role: 'user' | 'model'; parts: any[] }>; threadImages: any[] }> {
    try {
      const rawReplies = await this.slackClient.getConversationReplies(event.channel, threadTs);
      const replies = Array.isArray(rawReplies) ? rawReplies : [];
      const botUserId = process.env.SLACK_BOT_USER_ID;
      const rootMsg = replies.find((m: any) => m && m.ts === threadTs);
      const otherPriors = replies.filter((msg: any) => msg && msg.ts !== event.ts && msg.ts !== threadTs);
      // Keep root message (original topic/goal) plus up to the last 8 recent exchanges
      const recentPriors = otherPriors.slice(-8);
      const priorMessages = rootMsg && rootMsg.ts !== event.ts
        ? [rootMsg, ...recentPriors]
        : recentPriors;

      // Find up to 4 most recent image files across prior thread messages
      const MAX_THREAD_IMAGES = 4;
      const imageCandidates: Array<{ msgIdx: number; file: any }> = [];
      for (let i = 0; i < priorMessages.length; i++) {
        const files: any[] = Array.isArray(priorMessages[i].files) ? (priorMessages[i].files as any[]) : [];
        for (const f of files) {
          if ((f?.url_private_download || f?.url_private) && f?.mimetype?.startsWith('image/')) {
            imageCandidates.push({ msgIdx: i, file: f });
          }
        }
      }
      const selectedCandidates = imageCandidates.slice(-MAX_THREAD_IMAGES);
      const downloadedByMsg = new Map<number, any[]>();
      const threadImages: any[] = [];

      if (typeof this.slackClient.downloadFile === 'function' && selectedCandidates.length > 0) {
        const downloaded = await Promise.all(
          selectedCandidates.map(async ({ msgIdx, file }) => {
            try {
              const fileUrl = (file.url_private_download || file.url_private)!;
              const cacheKey = file.id || fileUrl;
              let cached = this.imageCache.get(cacheKey);
              if (!cached) {
                const res = await this.slackClient.downloadFile(fileUrl);
                if (!res) return null;
                cached = {
                  mimeType: file.mimetype || res.mimeType || 'image/png',
                  data: res.buffer.toString('base64')
                };
                if (this.imageCache.size >= 32) {
                  const oldestKey = this.imageCache.keys().next().value;
                  if (oldestKey !== undefined) this.imageCache.delete(oldestKey);
                }
                this.imageCache.set(cacheKey, cached);
              }
              const part = {
                inlineData: {
                  mimeType: cached.mimeType,
                  data: cached.data
                },
                mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' }
              };
              return { msgIdx, part };
            } catch {
              return null;
            }
          })
        );
        for (const item of downloaded) {
          if (!item) continue;
          const list = downloadedByMsg.get(item.msgIdx) || [];
          list.push(item.part);
          downloadedByMsg.set(item.msgIdx, list);
          threadImages.push(item.part);
        }
      }

      // Find up to 4 most recent non-image files across prior thread messages
      const fileCandidates: Array<{ msgIdx: number; file: any }> = [];
      for (let i = 0; i < priorMessages.length; i++) {
        const files: any[] = Array.isArray(priorMessages[i].files) ? (priorMessages[i].files as any[]) : [];
        for (const f of files) {
          if ((f?.url_private_download || f?.url_private) && (!f?.mimetype || !f?.mimetype.startsWith('image/'))) {
            fileCandidates.push({ msgIdx: i, file: f });
          }
        }
      }
      const selectedFileCandidates = fileCandidates.slice(-4);
      if (typeof this.slackClient.downloadFile === 'function' && selectedFileCandidates.length > 0) {
        const downloadedFiles = await Promise.all(
          selectedFileCandidates.map(async ({ msgIdx, file }) => {
            try {
              const fileUrl = (file.url_private_download || file.url_private)!;
              const cacheKey = file.id || fileUrl;
              let cached = this.fileCache.get(cacheKey);
              if (!cached) {
                const res = await this.slackClient.downloadFile(fileUrl);
                if (!res) return null;
                cached = res;
                if (this.fileCache.size >= 32) {
                  const oldestKey = this.fileCache.keys().next().value;
                  if (oldestKey !== undefined) this.fileCache.delete(oldestKey);
                }
                this.fileCache.set(cacheKey, cached);
              }
              const extracted = await extractFileContent(
                { name: file.name, mimetype: file.mimetype || cached.mimeType, size: file.size ?? cached.buffer.length },
                cached.buffer
              );

              if (extracted.sheets && extracted.sheets.length > 0) {
                const store = this.getResultStore();
                let text = extracted.text;
                if (store) {
                  const fileName = file.name || 'unnamed_file';
                  const effectiveRunId = runId || `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
                  const handle = store.keep(effectiveRunId, 'attached_spreadsheet', { fileName, sheets: extracted.sheets });
                  const available = extracted.sheets
                    .map(s => `"${s.name}" (${s.rows.length} row${s.rows.length === 1 ? '' : 's'})`)
                    .join(', ');
                  const header = `[Attached Spreadsheet: ${fileName} (handle: ${handle})]\nAvailable tables/sheets: ${available}`;
                  const body = extracted.text.replace(/^\[Attached (?:Spreadsheet|CSV File|TSV File): [^\]]+\]\n?/, '');
                  text = `${header}\n${body}`.trim();
                  if (this.carryover) {
                    const threadKey = `${event.channel}:${threadTs}`;
                    try {
                      this.carryover.recordHandle(
                        threadKey,
                        effectiveRunId,
                        'attached_spreadsheet',
                        fileName,
                        handle,
                        `Available tables/sheets: ${available}`
                      );
                    } catch (err: any) {
                      console.warn('[SlackCoworkerService] Failed to record attached spreadsheet in carryover:', err.message);
                    }
                  }
                }
                return { msgIdx, part: { text } };
              }

              return { msgIdx, part: { text: extracted.text } };
            } catch {
              return null;
            }
          })
        );
        for (const item of downloadedFiles) {
          if (!item) continue;
          const list = downloadedByMsg.get(item.msgIdx) || [];
          list.push(item.part);
          downloadedByMsg.set(item.msgIdx, list);
        }
      }

      const history: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
      for (let i = 0; i < priorMessages.length; i++) {
        const msg = priorMessages[i];
        const isFromBot = (botUserId && msg.user === botUserId) || Boolean(msg.bot_id);
        const cleanText = (msg.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
        // Bound long previous messages (e.g. earlier giant outputs) to 2000 chars
        const boundedText = cleanText.length > 2000 ? `${cleanText.slice(0, 2000)}… [earlier output truncated]` : cleanText;
        const msgAttachments = downloadedByMsg.get(i) || [];
        const parts: any[] = [];
        if (boundedText) parts.push({ text: boundedText });
        if (msgAttachments.length > 0) parts.push(...msgAttachments);
        if (parts.length > 0) {
          history.push({ role: isFromBot ? 'model' : 'user', parts });
        }
      }

      return { history, threadImages };
    } catch (err: any) {
      console.warn('[SlackCoworkerService] Failed to load thread history:', err.message);
      return { history: [], threadImages: [] };
    }
  }

  private async downloadImages(event: SlackEventPayload): Promise<any[]> {
    const images = (event.files || []).filter(f => (f.url_private_download || f.url_private) && f.mimetype?.startsWith('image/'));
    if (images.length === 0 || typeof this.slackClient.downloadFile !== 'function') return [];
    const parts = await Promise.all(images.slice(0, 4).map(async f => {
      try {
        const fileUrl = (f.url_private_download || f.url_private)!;
        const cacheKey = f.id || fileUrl;
        let cached = this.imageCache.get(cacheKey);
        if (!cached) {
          const downloaded = await this.slackClient.downloadFile(fileUrl);
          if (!downloaded) return null;
          cached = {
            mimeType: f.mimetype || 'image/png',
            data: downloaded.buffer.toString('base64')
          };
          if (this.imageCache.size >= 32) {
            const oldestKey = this.imageCache.keys().next().value;
            if (oldestKey !== undefined) this.imageCache.delete(oldestKey);
          }
          this.imageCache.set(cacheKey, cached);
        }
        return {
          inlineData: { mimeType: cached.mimeType, data: cached.data },
          mediaResolution: { level: 'MEDIA_RESOLUTION_MEDIUM' }
        };
      } catch (fileErr: any) {
        console.warn(`[SlackCoworkerService] Failed to download attached image ${f.name}:`, fileErr.message);
        return null;
      }
    }));
    return parts.filter(Boolean);
  }

  private async downloadAndExtractFiles(event: SlackEventPayload, threadKey?: string, runId?: string): Promise<any[]> {
    const files = (event.files || []).filter(
      f => (f.url_private_download || f.url_private) && (!f.mimetype || !f.mimetype.startsWith('image/'))
    );
    if (files.length === 0) return [];

    const MAX_FILES = 5;
    const parts = await Promise.all(
      files.slice(0, MAX_FILES).map(async f => {
        const fileUrl = (f.url_private_download || f.url_private)!;
        const cacheKey = f.id || fileUrl;

        if (typeof this.slackClient.downloadFile !== 'function') {
          return {
            text: `[Attached File: ${f.name || 'unnamed'} (${f.mimetype || 'unknown'})]`
          };
        }

        try {
          let cached = this.fileCache.get(cacheKey);
          if (!cached) {
            const downloaded = await this.slackClient.downloadFile(fileUrl);
            if (!downloaded) {
              return {
                text: `[Attached File: ${f.name || 'unnamed'} (${f.mimetype || 'unknown'}) - file could not be downloaded]`
              };
            }
            cached = downloaded;
            if (this.fileCache.size >= 32) {
              const oldestKey = this.fileCache.keys().next().value;
              if (oldestKey !== undefined) this.fileCache.delete(oldestKey);
            }
            this.fileCache.set(cacheKey, cached);
          }

          const extracted = await extractFileContent(
            {
              name: f.name,
              mimetype: f.mimetype || cached.mimeType,
              size: f.size ?? cached.buffer.length
            },
            cached.buffer
          );

          if (extracted.sheets && extracted.sheets.length > 0) {
            const store = this.getResultStore();
            let text = extracted.text;
            if (store) {
              const fileName = f.name || 'unnamed_file';
              const effectiveRunId = runId || `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
              const handle = store.keep(effectiveRunId, 'attached_spreadsheet', { fileName, sheets: extracted.sheets });
              const available = extracted.sheets
                .map(s => `"${s.name}" (${s.rows.length} row${s.rows.length === 1 ? '' : 's'})`)
                .join(', ');
              const header = `[Attached Spreadsheet: ${fileName} (handle: ${handle})]\nAvailable tables/sheets: ${available}`;
              const body = extracted.text.replace(/^\[Attached (?:Spreadsheet|CSV File|TSV File): [^\]]+\]\n?/, '');
              text = `${header}\n${body}`.trim();
              if (this.carryover) {
                const effectiveThreadKey = threadKey || `${event.channel}:${event.thread_ts || event.ts}`;
                try {
                  this.carryover.recordHandle(
                    effectiveThreadKey,
                    effectiveRunId,
                    'attached_spreadsheet',
                    fileName,
                    handle,
                    `Available tables/sheets: ${available}`
                  );
                } catch (err: any) {
                  console.warn('[SlackCoworkerService] Failed to record attached spreadsheet in carryover:', err.message);
                }
              }
            }
            return { text };
          }

          return { text: extracted.text };
        } catch (fileErr: any) {
          console.warn(`[SlackCoworkerService] Failed to extract file ${f.name}:`, fileErr.message);
          return {
            text: `[Attached File: ${f.name || 'unnamed'} (${f.mimetype || 'unknown'}) - error extracting content: ${fileErr.message}]`
          };
        }
      })
    );

    return parts.filter(Boolean);
  }

  private async deliverResult(event: SlackEventPayload, runResult: UnifiedRunResult, threadTs: string, status?: SlackStatusReporter): Promise<void> {
    const output = runResult.output;
    const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    const isQuestion = isUserQuestionOrPing(cleanText);

    // Consequential actions staged in this run each get a quote card
    const staged = this.ledgerRepo.listStagedByRun(runResult.runId);

    if (staged.length > 0) {
      await this.slackClient.removeReaction({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      const statusReplaced = output.coworkerHeadline
        ? await status?.finish(output.coworkerHeadline, 'suspended')
        : await status?.finish('Ready for your approval below.', 'suspended');
      if (typeof this.slackClient.setSessionStatus === 'function') {
        await this.slackClient.setSessionStatus({
          channel: event.channel,
          thread_ts: threadTs,
          status: 'suspended'
        }).catch(() => {});
      }
      for (const [i, action] of staged.entries()) {
        const payload = JSON.parse(action.payload_json);
        const blocks = buildQuoteCardBlocks(action.id, action.action_type, payload);
        const headline = (i === 0 && !statusReplaced && output.coworkerHeadline) || `Staged ${action.action_type} for your approval.`;

        const cardMsg = await this.slackClient.postMessage({
          channel: event.channel,
          text: headline,
          blocks,
          thread_ts: threadTs
        });

        if (cardMsg.ts) {
          this.ledgerRepo.updateSlackCardTs(action.id, cardMsg.ts);
        }
        if (i === 0) this.recordDelivered(runResult.runId, (statusReplaced && output.coworkerHeadline) || headline);
        this.recordDelivered(runResult.runId, `[card ${action.id}: ${action.action_type}${payload.to ? ' → ' + payload.to : ''}]`);
      }
      return;
    }

    // Never ghost the user: if user asked a question/ping or if deliveryMode is SILENT on Slack, force SLACK_MESSAGE
    let effectiveDeliveryMode = output.deliveryMode;
    if (isQuestion || effectiveDeliveryMode === 'SILENT') {
      effectiveDeliveryMode = 'SLACK_MESSAGE';
    }

    if (effectiveDeliveryMode === 'REACTION_ONLY') {
      // Reversible task: Switch reaction to white_check_mark with ZERO text
      await status?.finish('✅ Done.', 'active');
      if (typeof this.slackClient.setSessionStatus === 'function') {
        await this.slackClient.setSessionStatus({
          channel: event.channel,
          thread_ts: threadTs,
          status: 'active'
        }).catch(() => {});
      }
      await this.slackClient.removeReaction({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      await this.slackClient.addReaction({
        channel: event.channel,
        timestamp: event.ts,
        name: output.reactionEmoji || 'white_check_mark'
      }).catch(() => {});
      this.recordDelivered(runResult.runId, `[reaction :${output.reactionEmoji || 'white_check_mark'}:]`);
      return;
    }

    // SLACK_MESSAGE: Conversational message (1-3 sentences + optional artifact link)
    await this.slackClient.removeReaction({ channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
    let headline = output.slackMessage || output.coworkerHeadline;

    const trimmed = headline ? headline.trim() : '';
    if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      headline = (output.summary && !output.summary.trim().startsWith('{'))
        ? output.summary
        : '';
    }

    if (!headline || !headline.trim()) {
      headline = stoppedEarlyMessage(runResult.status, runResult.toolCallsExecuted || [], runResult.error);
    }

    const link = output.artifactLink && !headline.includes(output.artifactLink) ? `\n${output.artifactLink}` : '';
    const fullText = `${headline}${link}`;
    this.recordDelivered(runResult.runId, fullText);

    // Replace the live status message with the answer; post fresh only if there was none
    const replaced = await status?.finish(fullText, 'active');
    if (typeof this.slackClient.setSessionStatus === 'function') {
      await this.slackClient.setSessionStatus({
        channel: event.channel,
        thread_ts: threadTs,
        status: 'active'
      }).catch(() => {});
    }
    if (replaced) return;
    await this.slackClient.postMessage({
      channel: event.channel,
      text: fullText,
      thread_ts: threadTs
    });
  }

  private async handleInThreadRevision(stagedAction: any, event: SlackEventPayload): Promise<boolean> {
    const currentPayload = JSON.parse(stagedAction.payload_json);

    // Run quick model update to revise the staged draft
    const revisePrompt = `The owner provided this feedback to revise a staged action draft:
"${event.text}"

CURRENT PAYLOAD:
${JSON.stringify(currentPayload)}

Return ONLY the updated JSON payload object matching the existing structure. No commentary.`;

    const router = this.getModelRouter();
    const modelResponse = router ? await router.generate(revisePrompt, {
      tier: 'SENTINEL',
      thinkingLevel: 'low',
      temperature: 0.1,
      responseMimeType: 'application/json',
      source: 'in_thread_revision'
    }) : { text: '{}' };

    let updatedPayload = currentPayload;
    try {
      updatedPayload = JSON.parse(modelResponse.text);
    } catch {}

    const dispatcher = this.getDispatcher();
    const tool = dispatcher?.getTool?.(stagedAction.action_type);
    updatedPayload = stripRepeatedHeaders(tool, updatedPayload) as Record<string, any>;

    const ownerContentActions = new Set([
      'gmail_send',
      'proton_send',
      'gmail_draft',
      'proton_draft',
      'docs_create',
      'docs_append',
      'document_render',
      'visual_document_render'
    ]);
    const isOwnerContent = Boolean(tool?.ownerText) || ownerContentActions.has(stagedAction.action_type);
    const claimsGuard = (this as any).claimsGuard || dispatcher?.getClaimsGuard?.() || (dispatcher as any)?.['claimsGuard'];

    if (isOwnerContent && claimsGuard) {
      const textToCheck = tool?.ownerText?.text
        ? tool.ownerText.text(updatedPayload)
        : [
            updatedPayload.title,
            updatedPayload.heading,
            updatedPayload.subject,
            updatedPayload.body ?? updatedPayload.bodyText ?? updatedPayload.text ?? updatedPayload.content ?? updatedPayload.markdown ?? ''
          ].filter(v => typeof v === 'string' && v.trim().length > 0).join('\n\n');

      const { refusals } = await reviewOwnerText(claimsGuard, 'message', textToCheck, {
        evidence: [event.text, JSON.stringify(currentPayload)],
        identity: true
      });

      if (refusals.length > 0) {
        await this.slackClient.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts || event.ts,
          text: `⛔ *Cannot update staged ${stagedAction.action_type}:* ${refusals.join(' | ')}`
        }).catch(() => {});
        return false;
      }
    }

    // Update in place in ledger
    this.ledgerRepo.updateStagedPayload(stagedAction.id, updatedPayload, `slack:${event.user}`);

    // Update quote card in Slack and extract style/tone lesson concurrently
    const updateSlackCard = async () => {
      if (stagedAction.slack_card_ts) {
        const blocks = buildQuoteCardBlocks(stagedAction.id, stagedAction.action_type, updatedPayload);
        await this.slackClient.updateMessage({
          channel: event.channel,
          ts: stagedAction.slack_card_ts,
          text: `Updated staged ${stagedAction.action_type} per your feedback:`,
          blocks
        }).catch(() => {});
      }
    };

    const extractAndRecordLesson = async () => {
      const memory = this.memoryRepo || (this.runner as any).memoryRepo || (this.runner as any).getMemoryRepo?.();
      const router = this.getModelRouter();
      if (memory) {
        try {
          const lesson = await extractCorrectionLesson(router, {
            actionType: stagedAction.action_type,
            feedback: event.text,
            oldPayload: currentPayload,
            newPayload: updatedPayload
          });

          if (lesson) {
            const feedbackText = event.text || '';
            const explicitGlobal = /^(always|never|from now on|global rule)\b/i.test(feedbackText.trim()) ||
              /\b(always|never)\s+/i.test(feedbackText) ||
              /cut pleasantries/i.test(feedbackText);

            if (explicitGlobal) {
              const existingFacts = memory.searchFacts(lesson);
              const alreadyExists = existingFacts.some((f: any) => f.statement.toLowerCase() === lesson.toLowerCase());
              if (!alreadyExists) {
                const addedFact = memory.addFact(lesson, 'preferences', 'PREFERENCE', 0.9, 'correction');
                if (addedFact && typeof memory.recordRrsiProposal === 'function') {
                  memory.recordRrsiProposal({
                    componentType: 'memory_fact',
                    targetId: addedFact.id,
                    hypothesis: `Explicit owner rule on ${stagedAction.action_type || 'global'}`,
                    diffText: lesson,
                    accepted: true
                  });
                }
              }
            } else {
              const normalizedKey = lesson.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 50);
              memory.recordCandidate(normalizedKey, lesson, stagedAction.action_type || 'global');
            }
          }
        } catch (err: any) {
          console.warn('[SlackCoworkerService] Failed to extract correction lesson:', err.message);
        }
      }
    };

    await Promise.all([updateSlackCard(), extractAndRecordLesson()]);

    return true;
  }

  public async notifyBatchStaged(batchId: string, count: number, routineTitle: string): Promise<void> {
    if (!this.slackClient.isConfigured()) return;
    const url = `${this.missionControlUrl}/`;
    const text = `Sourced ${count} items for ${routineTitle}. Review and approve them on the control page: ${url}`;

    await this.slackClient.postMessage({
      channel: this.slackClient.defaultChannel,
      text
    });
  }

  public async handleButtonInteraction(payload: any): Promise<void> {
    const action = payload.actions?.[0];
    if (!action) return;

    const actionId = action.value;
    const actionType = action.action_id; // 'approve_action' | 'drop_action'
    const channel = payload.channel?.id;
    const messageTs = payload.message?.ts;
    const actor = `slack:${payload.user?.id || 'owner'}`;
    const record = this.ledgerRepo.get(actionId);
    const recordPayload = record ? safeParse(record.payload_json) : undefined;
    const recordType = record?.action_type || '';
    const memory = this.memoryRepo || (this.runner as any)?.memoryRepo || (this.runner as any)?.getMemoryRepo?.();

    const settle = async (state: SettledCardState, detail: string) => {
      if (!channel || !messageTs) return;
      await this.slackClient.updateMessage({
        channel,
        ts: messageTs,
        text: detail,
        blocks: buildSettledCardBlocks(actionId, recordType, state, detail, recordPayload)
      }).catch(() => {});

      const threadTs = payload.message?.thread_ts || record?.slack_thread_ts || messageTs;
      if (threadTs && typeof this.slackClient.setSessionStatus === 'function') {
        const remainingStaged = this.ledgerRepo.getLatestStagedByThreadTs(threadTs);
        if (!remainingStaged) {
          await this.slackClient.setSessionStatus({
            channel,
            thread_ts: threadTs,
            status: 'active'
          }).catch(() => {});
        }
      }
    };

    if (actionType === 'approve_action') {
      if (!this.executeAction) {
        try {
          this.ledgerRepo.approveAction(actionId, actor);
          if (memory && recordType && typeof memory.recordRrsiTrial === 'function') {
            memory.recordRrsiTrial(recordType, 0.5);
          }
          await settle('APPROVED', 'Approved. Execute it from the control page.');
        } catch (err: any) {
          await settle('FAILED_SAFE', err.message);
        }
        return;
      }

      const outcome = await this.executeAction(actionId, actor);
      const current = this.ledgerRepo.get(actionId);
      if (outcome.ok) {
        if (memory && recordType && typeof memory.recordRrsiTrial === 'function') {
          memory.recordRrsiTrial(recordType, 0.5);
        }
        await settle(outcome.status === 'VERIFIED' ? 'VERIFIED' : 'PROVIDER_CONFIRMED', outcome.message);
        if (recordType === 'composio_install_tool') {
          await this.handlePostApprovedInstall(
            current || record,
            recordPayload,
            outcome,
            channel,
            payload.message?.thread_ts || messageTs,
            payload.user?.id || 'owner'
          );
        }
      } else if (current?.state === 'STAGED') {
        // Blocked by policy before approval: keep the card actionable and say why in the thread
        if (channel) {
          await this.slackClient.postMessage({
            channel,
            thread_ts: payload.message?.thread_ts || messageTs,
            text: `Did not send: ${outcome.message} Reply in this thread to change it, or press Drop.`
          }).catch(() => {});
        }
      } else {
        await settle(outcome.status === 'RECONCILIATION_REQUIRED' ? 'RECONCILIATION_REQUIRED' : 'FAILED_SAFE', outcome.message);
      }
    } else if (actionType === 'drop_action') {
      try {
        this.ledgerRepo.denyAction(actionId, actor, 'Dropped from Slack');
        if (memory && recordType && typeof memory.recordNegativeEvidence === 'function') {
          memory.recordNegativeEvidence(recordType);
        }
        await settle('DENIED', 'Dropped.');
      } catch (err: any) {
        console.warn(`[SlackCoworker] Failed to drop action ${actionId}:`, err.message);
        await settle('FAILED_SAFE', err.message);
      }
    }
  }

  /**
   * Once the owner approves a composio_install_tool proposal:
   * - If external OAuth click is required (PENDING_AUTH / NEEDS_AUTH), posts the setup link/instructions in the thread.
   * - If the tool is READY, immediately continues the conversation run with the newly installed tool to finish the task.
   */
  public async handlePostApprovedInstall(
    record: any,
    recordPayload: Record<string, any> | undefined,
    outcome: ExecutionResult,
    fallbackChannel?: string,
    fallbackThreadTs?: string,
    userId = 'owner'
  ): Promise<UnifiedRunResult | null> {
    const installRes = outcome.result || {};
    const targetChannel = fallbackChannel || record?.slack_channel || this.slackClient.defaultChannel;
    const targetThreadTs = record?.slack_thread_ts || fallbackThreadTs;
    const toolSlug = installRes.toolSlug || recordPayload?.toolSlug || 'Composio tool';
    const registeredToolName = installRes.registeredToolName || `composio_${String(toolSlug).toLowerCase()}`;
    const pendingTask = installRes.pendingTask || recordPayload?.pendingTask || '';
    const connectionStatus = installRes.connectionStatus || 'READY';

    if (connectionStatus !== 'READY') {
      if (targetChannel) {
        const redirectLink = installRes.redirectUrl
          ? `Authorize it here: <${installRes.redirectUrl}|Connect ${installRes.toolkitSlug || toolSlug} on Composio>.`
          : (installRes.message || 'Complete the toolkit authentication in Composio.');
        const followUp = pendingTask
          ? ` Once connected, reply "connected" in this thread and I will finish: _${pendingTask}_`
          : '';
        await this.slackClient.postMessage({
          channel: targetChannel,
          thread_ts: targetThreadTs,
          text: `🔗 *Installed \`${toolSlug}\` — setup required:* ${redirectLink}${followUp}`
        }).catch(() => {});
      }
      return null;
    }

    if (!pendingTask || typeof this.runner?.run !== 'function') {
      return null;
    }

    const threadTs = targetThreadTs || `${Date.now()}`;
    const threadKey = `${targetChannel}:${threadTs}`;
    const syntheticEvent: SlackEventPayload = {
      type: 'message',
      user: userId,
      text: pendingTask,
      ts: threadTs,
      thread_ts: threadTs,
      channel: targetChannel || ''
    };

    const conversationHistory = targetChannel && targetThreadTs
      ? await this.loadThreadHistory(syntheticEvent, threadTs)
      : [];
    const earlierWork = this.carryover?.get(threadKey);
    const inlined = earlierWork ? (this.carryover?.inlineResults(threadKey) ?? []) : [];

    const instruction =
      `[COMPOSIO TOOL INSTALLED & READY] The owner approved installing '${toolSlug}' (registered as '${registeredToolName}', also callable via 'composio_execute_tool'). ` +
      `Connection status is READY. Use '${registeredToolName}' (or 'composio_execute_tool' with toolSlug '${toolSlug}') right now to complete the task: ${pendingTask}`;

    const userParts: any[] = [{ text: instruction }];
    if (earlierWork) {
      userParts.push({ text: `[Context from earlier in this thread:]\n${earlierWork}` });
    }
    if (inlined.length > 0) {
      userParts.push({
        text: `[Full text of shorter items from earlier in this thread:]\n${inlined.map(i => `--- ${i.tool}(${i.params}) [handle ${i.handle}]\n${i.text}`).join('\n')}`
      });
    }

    const dispatcher = this.getDispatcher();
    const allToolNames = new Set<string>(
      (dispatcher?.getAllTools?.() || []).map((t: any) => t.name)
    );
    allToolNames.add(registeredToolName);
    allToolNames.add('composio_execute_tool');

    const status = targetChannel ? new SlackStatusReporter(this.slackClient, targetChannel, threadTs) : undefined;
    const runResult = await this.runner.run({
      trigger: 'slack_dm',
      instruction: pendingTask,
      userParts,
      conversationHistory,
      inlinedHandles: inlined.map(i => i.handle),
      tier: 'INTERACTIVE',
      isInteractive: true,
      maxRounds: INTERACTIVE_MAX_ROUNDS,
      timeBudgetMs: INTERACTIVE_TIME_BUDGET_MS,
      onToolStart: tool => status?.step(tool),
      toolGrant: {
        allowedToolNames: allToolNames,
        allowConsequential: true
      },
      slackOrigin: targetChannel
        ? {
            channel: targetChannel,
            threadTs,
            user: userId,
            isDirectMessage: true
          }
        : undefined
    });

    if (targetChannel) {
      try {
        this.carryover?.save(threadKey, runResult);
      } catch {}
      await this.deliverResult(syntheticEvent, runResult, threadTs, status);
    }

    return runResult;
  }

  /**
   * Handles user clicking "Stop" in Slack Agent session.
   * Aborts active interactive execution and background continuation,
   * sets session status back to 'active', and posts a concise confirmation.
   */
  public async handleSessionStopped(event: { channel: string; thread_ts: string; user?: string }): Promise<void> {
    const threadKey = `${event.channel}:${event.thread_ts}`;
    const activeCtrl = this.activeRunAbortControllers.get(threadKey);
    if (activeCtrl) {
      activeCtrl.abort();
      this.activeRunAbortControllers.delete(threadKey);
    }
    const bgCtrl = this.backgroundAbortControllers.get(threadKey);
    if (bgCtrl) {
      bgCtrl.abort();
      this.backgroundAbortControllers.delete(threadKey);
    }
    if (typeof this.slackClient.setSessionStatus === 'function') {
      await this.slackClient.setSessionStatus({
        channel: event.channel,
        thread_ts: event.thread_ts,
        status: 'active'
      }).catch(() => {});
    }
    await this.slackClient.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: '⏹️ Stopped.'
    }).catch(() => {});
  }

  /**
   * Sets contextual suggested prompts when user opens the agent view.
   */
  public async handleAppHomeOpened(event: { user: string; channel: string; tab?: string }): Promise<void> {
    if (event.tab && event.tab !== 'messages') return;
    const hour = new Date().getHours();
    const prompts = hour < 12
      ? [
          { title: 'Morning Briefing', message: "What's on my calendar today and what unread emails need attention?" },
          { title: 'Project Status', message: 'Give me a quick status update on my active projects.' },
          { title: 'Search Slack', message: 'Search Slack for any mentions or key updates from yesterday.' }
        ]
      : [
          { title: 'Afternoon Catch-up', message: 'What unread messages or waiting items need my response?' },
          { title: 'Tomorrow Schedule', message: "What is on my calendar for tomorrow and what should I prepare?" },
          { title: 'Daily Wrap-up', message: 'Summarize today’s progress and open items.' }
        ];

    if (typeof this.slackClient.setSuggestedPrompts === 'function') {
      await this.slackClient.setSuggestedPrompts({
        channel_id: event.channel,
        prompts
      }).catch(() => {});
    }
  }

  /**
   * Tracks user active context changes (focus on specific channel, thread, canvas, etc.).
   */
  public handleAppContextChanged(event: { user: string; context: any }): void {
    if (event.user && event.context) {
      this.userActiveContext.set(event.user, event.context);
    }
  }

  public getActiveContext(user: string): any {
    return this.userActiveContext.get(user);
  }
}

function safeParse(json: string): Record<string, any> | undefined {
  try { return JSON.parse(json); } catch { return undefined; }
}
