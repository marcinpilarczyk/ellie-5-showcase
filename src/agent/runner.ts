import { ModelRouter, ModelTier, reasoningRequestedInThread } from '../models/model-router.js';
import { ToolDispatcher } from '../governance/dispatcher.js';
import { MemoryRepository } from '../storage/memory-repo.js';
import { RunTraceStore } from '../storage/run-trace-store.js';
import {
  DeliveryMode,
  FinishStatus,
  TokenTelemetry,
  ToolCallExecutionRecord,
  UnifiedAgentOutput,
  UnifiedRunResult
} from '../types/runner.js';
import { ToolExecutionContext, ToolGrant } from '../types/tool.js';
import { groundReply } from '../governance/reply-grounding.js';
import { nowLine } from '../config/time.js';
import { buildPrefixInstruction, formatToolsForGemini } from './prefix-builder.js';
import type { OwnerConfigLoader } from '../config/owner.js';

export interface UnifiedRunOptions {
  runId?: string;
  trigger: 'slack_dm' | 'routine' | 'sentinel' | 'manual' | 'subtask' | 'background_continuation';
  instruction: string;
  userParts?: any[];
  conversationHistory?: Array<{ role: 'user' | 'model'; parts: any[] }>;
  tier?: ModelTier;
  toolGrant: ToolGrant;
  isInteractive?: boolean;
  batchId?: string;
  subtaskDepth?: number;
  slackOrigin?: {
    channel: string;
    threadTs?: string;
    user?: string;
    isDirectMessage?: boolean;
  };
  maxRounds?: number;
  /**
   * Result Store handles whose text is already in userParts (carried from earlier runs in a thread). They count as
   * evidence exactly as a result_read of the same handle would.
   */
  inlinedHandles?: string[];
  /** Wall-clock budget; once spent, the next model call may only be finish. */
  timeBudgetMs?: number;
  abortSignal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /** Called as each tool starts, for live status in Slack. */
  onToolStart?: (toolName: string, round: number) => void;
}

export const UNIFIED_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    deliveryMode: {
      type: 'string',
      enum: ['REACTION_ONLY', 'SLACK_MESSAGE', 'SILENT'],
      description: "Use 'SLACK_MESSAGE' for conversations, questions, status inquiries, research findings, and substantive answers. Use 'REACTION_ONLY' ONLY for simple non-conversational execution commands. Use 'SILENT' ONLY for autonomous background cron routines with nothing to report. NEVER choose SILENT in direct conversations."
    },
    reactionEmoji: {
      type: 'string',
      description: "Emoji name like 'white_check_mark' or 'eyes' for REACTION_ONLY delivery"
    },
    coworkerHeadline: {
      type: 'string',
      description: 'Natural 1-2 sentence coworker headline for Slack answering the user directly (leave empty string ONLY if REACTION_ONLY)'
    },
    slackMessage: {
      type: 'string',
      description: 'Concise message text to deliver to the owner'
    },
    artifactLink: {
      type: 'string',
      description: 'URL or path to artifact (Sheet / Doc / approvals page)'
    },
    requiresClarification: {
      type: 'boolean',
      description: 'True if input was ambiguous and owner clarification is needed'
    },
    summary: {
      type: 'string',
      description: 'Internal brief recap of what was accomplished'
    }
  },
  required: ['deliveryMode', 'coworkerHeadline', 'summary']
};

export function isUserQuestionOrPing(text?: string): boolean {
  if (!text) return false;
  const clean = text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (clean.includes('?')) return true;

  const questionPattern = /^(so\b|status\b|why\b|what\b|how\b|when\b|where\b|who\b|which\b|is\b|are\b|can\b|could\b|will\b|would\b|should\b|update\b|explain\b|tell\b|help\b|dlaczego\b|czemu\b|co\b|jak\b|kiedy\b|gdzie\b|kto\b|który\b|czy\b|jaki\b|jaka\b|jakie\b|i jak\b|co tam\b|o co chodzi\b|co jest\b|ping\b|halo\b)/i;
  if (questionPattern.test(clean)) return true;

  if (/^[\?!.]+$/.test(clean)) return true;

  return false;
}

export function sanitizeContents(rawContents: Array<{ role: 'user' | 'model'; parts: any[] }>): Array<{ role: 'user' | 'model'; parts: any[] }> {
  const filtered = rawContents.filter(turn => turn && Array.isArray(turn.parts) && turn.parts.length > 0);
  if (filtered.length === 0) return [];

  // Drop leading model turns so conversation always starts with user
  while (filtered.length > 0 && filtered[0].role !== 'user') {
    filtered.shift();
  }
  if (filtered.length === 0) return [];

  // Merge consecutive turns of identical role
  const sanitized: Array<{ role: 'user' | 'model'; parts: any[] }> = [];
  for (const turn of filtered) {
    const prev = sanitized[sanitized.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts.push(...turn.parts);
    } else {
      sanitized.push({
        role: turn.role,
        parts: [...turn.parts]
      });
    }
  }

  return sanitized;
}

/**
 * A tool result's confirm line is what Ellie understood from free text (a schedule, a new routine), so the
 * owner sees it in words: a reaction alone is upgraded to a message, and an empty message gets the lines.
 */
export function withConfirmations(output: UnifiedAgentOutput, calls: ToolCallExecutionRecord[]): UnifiedAgentOutput {
  const lines = calls
    .map(c => (c.result && typeof c.result === 'object' && typeof c.result.confirm === 'string' ? c.result.confirm.trim() : ''))
    .filter(Boolean);
  if (lines.length === 0 || output.deliveryMode === 'SILENT') return output;
  if (output.deliveryMode === 'SLACK_MESSAGE' && output.slackMessage?.trim()) return output;
  const message = lines.join('\n');
  return { ...output, deliveryMode: 'SLACK_MESSAGE', reactionEmoji: undefined, coworkerHeadline: message, slackMessage: message };
}

/** Honest reply for a run that ended without a usable answer. Never promises work that is not happening. */
export function stoppedEarlyMessage(
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT',
  calls: ToolCallExecutionRecord[],
  error?: string
): string {
  if (status === 'TIMEOUT') {
    return 'I ran out of time before finishing this. Ask again and I will pick it up, or narrow it down.';
  }
  if (status === 'FAILED') {
    const reason = error ? ` (${error.slice(0, 160)})` : '';
    return `That failed on my side${reason}. The trace is on the control page under Runs.`;
  }
  if (calls.length === 0) {
    return "I did not get to an answer on that one. Can you rephrase or add a detail?";
  }
  const tools = [...new Set(calls.map(c => c.tool))].slice(0, 3).join(', ');
  return `I looked into it (${tools}) but stopped before reaching an answer. Tell me what to focus on and I will take it from there.`;
}

export const FINISH_TOOL_NAME = 'finish';

/**
 * The only way a run ends. Gemini is called with function-calling mode ANY, so every turn is a
 * tool call; prose like "working on it" can no longer be mistaken for the final answer.
 */
export const FINISH_DECLARATION = {
  name: FINISH_TOOL_NAME,
  description: 'End this run and hand the result to the owner. Call it ALONE, and only once the work is actually done, you need the owner\'s input, or you are blocked. Never call it to announce work you are about to do: do that work first with tools, then finish.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['DONE', 'NEEDS_INPUT', 'BLOCKED', 'NOTHING_TO_REPORT', 'CONTINUE_IN_BACKGROUND'],
        description: 'DONE: the answer or deliverable is complete. NEEDS_INPUT: you asked the owner a question. BLOCKED: you could not finish; say what is done and what is missing. NOTHING_TO_REPORT: a scheduled check found nothing new. CONTINUE_IN_BACKGROUND: the task requires extended work beyond the interactive window; Ellie will continue autonomously in the background and deliver to this thread when complete.'
      },
      message: {
        type: 'string',
        description: 'What the owner reads in Slack, in the language of their message: the answer, or a 1-6 sentence summary of the finished deliverable. Describe finished work in the past tense; never write "I am working on".'
      },
      deliveryMode: {
        type: 'string',
        enum: ['SLACK_MESSAGE', 'REACTION_ONLY', 'SILENT'],
        description: 'SLACK_MESSAGE by default. REACTION_ONLY only for a simple command that needs no reply. SILENT only for a scheduled run with nothing to report.'
      },
      reactionEmoji: { type: 'string', description: 'Emoji name for REACTION_ONLY, e.g. white_check_mark' },
      artifactLink: { type: 'string', description: 'URL of a doc/sheet returned by a tool in this run, if any' }
    },
    required: ['status', 'message']
  }
};

const FINISH_STATUSES: FinishStatus[] = ['DONE', 'NEEDS_INPUT', 'BLOCKED', 'NOTHING_TO_REPORT', 'CONTINUE_IN_BACKGROUND'];

const LAST_STEP_NOTE = 'This is your last step. Call finish now. If the work is complete, use status DONE. If work requires extended background execution beyond this turn, use status CONTINUE_IN_BACKGROUND and summarize current progress. If blocked or missing input, use status BLOCKED or NEEDS_INPUT.';
const REPEAT_NOTE = 'You already have these tool results. Stop calling tools and call finish now with what you know, saying plainly what is still missing.';

function appendUserNote(contents: any[], text: string): void {
  const lastTurn = contents[contents.length - 1];
  if (lastTurn?.role === 'user') {
    lastTurn.parts = [...lastTurn.parts, { text }];
  } else {
    contents.push({ role: 'user', parts: [{ text }] });
  }
}

export class UnifiedAgentRunner {
  constructor(
    private readonly modelRouter: ModelRouter,
    private readonly dispatcher: ToolDispatcher,
    private readonly memoryRepo?: MemoryRepository,
    private readonly runTraceStore?: RunTraceStore,
    private readonly ownerInventory?: { promptBlock(): string },
    private readonly ownerConfigLoader?: OwnerConfigLoader
  ) {}

  public getModelRouter(): ModelRouter {
    return this.modelRouter;
  }

  public getMemoryRepo(): MemoryRepository | undefined {
    return this.memoryRepo;
  }

  public getDispatcher(): ToolDispatcher {
    return this.dispatcher;
  }

  public getOwnerConfigLoader(): OwnerConfigLoader | undefined {
    return this.ownerConfigLoader;
  }

  /** Proactively warms the Gemini context cache for an interactive turn. */
  public warmInteractiveCache(toolGrant: ToolGrant, tier: ModelTier = 'INTERACTIVE'): void {
    try {
      const facts = this.memoryRepo?.getExecutiveFacts() || [];
      const systemInstruction = buildPrefixInstruction(facts, [this.ownerInventory?.promptBlock() ?? '']);
      const grantedTools = this.dispatcher.getDeclaredTools(toolGrant);
      const toolsConfig = formatToolsForGemini(grantedTools);
      toolsConfig[0].functionDeclarations.push(FINISH_DECLARATION);

      this.modelRouter.warmPrefixCache({
        tier,
        systemInstruction,
        tools: toolsConfig,
        toolConfig: { functionCallingConfig: { mode: 'ANY' } }
      });
    } catch {}
  }

  public async run(opts: UnifiedRunOptions): Promise<UnifiedRunResult> {
    const runStartedAt = Date.now();
    const runId = opts.runId || `run_${runStartedAt}_${Math.random().toString(36).substring(2, 9)}`;
    const maxRounds = opts.maxRounds || (opts.isInteractive ? 8 : 6);
    const earlierOwnerTexts = (opts.conversationHistory ?? []).filter(t => t.role === 'user')
      .flatMap(t => t.parts.map((p: any) => p?.text).filter((x: any): x is string => typeof x === 'string'));
    const wantsReasoning = !opts.tier && reasoningRequestedInThread(opts.instruction, earlierOwnerTexts);
    let currentTier: ModelTier = opts.tier || (wantsReasoning ? 'ANALYSIS' : (opts.isInteractive ? 'INTERACTIVE' : 'ROUTINE'));
    const softDeadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : undefined;

    // Refresh owner config if stale
    this.ownerConfigLoader?.refreshIfStale();

    // Load executive memory facts for byte-stable prefix
    const facts = this.memoryRepo?.getExecutiveFacts() || [];
    const systemInstruction = buildPrefixInstruction(facts, [this.ownerInventory?.promptBlock() ?? '']);

    // Declare only canonical granted tools; aliases stay dispatchable but cost no prompt tokens.
    // finish is always declared last so the prefix stays byte-stable.
    const grantedTools = this.dispatcher.getDeclaredTools(opts.toolGrant);
    const toolsConfig = formatToolsForGemini(grantedTools);
    toolsConfig[0].functionDeclarations.push(FINISH_DECLARATION);

    const recentImages: Array<{ mimeType: string; data: string; name?: string }> = [];
    for (const p of opts.userParts ?? []) {
      if (p?.inlineData?.data && (!p.inlineData.mimeType || p.inlineData.mimeType.startsWith('image/'))) {
        recentImages.push({
          mimeType: p.inlineData.mimeType || 'image/png',
          data: p.inlineData.data
        });
      }
    }
    for (const turn of [...(opts.conversationHistory ?? [])].reverse()) {
      for (const p of turn?.parts ?? []) {
        if (p?.inlineData?.data && (!p.inlineData.mimeType || p.inlineData.mimeType.startsWith('image/'))) {
          recentImages.push({
            mimeType: p.inlineData.mimeType || 'image/png',
            data: p.inlineData.data
          });
        }
      }
    }

    const toolExecutionContext: ToolExecutionContext = {
      runId,
      isInteractive: opts.isInteractive ?? true,
      toolGrant: opts.toolGrant,
      slackOrigin: opts.slackOrigin,
      batchId: opts.batchId,
      abortSignal: opts.abortSignal,
      onProgress: opts.onProgress,
      readMemo: new Map(),
      subtaskDepth: opts.subtaskDepth ?? 0,
      recentImages,
      // The owner's own words in this thread count as a source. Ellie's earlier replies and the
      // carryover in userParts do not: they can repeat what she wrote, not what she read.
      evidence: [
        opts.instruction,
        ...(opts.conversationHistory ?? []).filter(turn => turn.role === 'user')
          .flatMap(turn => turn.parts.map((p: any) => p?.text).filter((t: any): t is string => typeof t === 'string'))
      ].filter(Boolean)
    };
    // Inlined carried results are evidence on the same terms as reading them with result_read
    for (const handle of opts.inlinedHandles ?? []) {
      if (!this.dispatcher.isEvidence('result_read', { handle })) continue;
      const stored = this.dispatcher.getResultStore()?.get(handle);
      if (stored) toolExecutionContext.evidence!.push(stored.content);
    }

    const toolCallsExecuted: ToolCallExecutionRecord[] = [];
    const handlesCreated: string[] = [];
    let consecutiveFailures = 0;
    let lastToolCallSignatures = '';
    let forceFinal = false;

    const aggregatedTelemetry: TokenTelemetry = {
      promptTokens: 0,
      cachedTokens: 0,
      thinkingTokens: 0,
      candidatesTokens: 0,
      totalTokens: 0,
      model: this.modelRouter.modelName,
      durationMs: 0
    };

    // Conversation history contents for Gemini multi-turn
    // The model has no clock: every run, whatever its trigger, starts with the local date and time.
    const currentParts = [
      { text: nowLine() },
      ...((opts.userParts && opts.userParts.length > 0) ? opts.userParts : [{ text: opts.instruction }])
    ];

    let contents: any[] = [];
    if (opts.conversationHistory && opts.conversationHistory.length > 0) {
      contents = sanitizeContents([
        ...opts.conversationHistory,
        { role: 'user', parts: currentParts }
      ]);
    } else {
      contents = [
        {
          role: 'user',
          parts: currentParts
        }
      ];
    }

    let finalOutput: UnifiedAgentOutput | null = null;
    let runStatus: 'COMPLETED' | 'FAILED' | 'TIMEOUT' = 'COMPLETED';
    let errorMessage: string | undefined;

    for (let round = 1; round <= maxRounds; round++) {
      if (opts.abortSignal?.aborted) {
        runStatus = 'TIMEOUT';
        errorMessage = 'Execution was aborted or timed out.';
        break;
      }

      // Out of time or rounds: the next call may only be finish
      const outOfTime = softDeadline !== undefined && Date.now() >= softDeadline;
      const isLastRound: boolean = round === maxRounds || forceFinal || outOfTime;
      if (isLastRound && !forceFinal) {
        appendUserNote(contents, LAST_STEP_NOTE);
      }
      forceFinal = isLastRound;

      const callConfig = {
        tier: currentTier,
        systemInstruction,
        tools: isLastRound ? [{ functionDeclarations: [FINISH_DECLARATION] }] : toolsConfig,
        toolConfig: {
          functionCallingConfig: isLastRound
            ? { mode: 'ANY', allowedFunctionNames: [FINISH_TOOL_NAME] }
            : { mode: 'ANY' }
        },
        // The finish-only last round has a different toolConfig; send it uncached
        cachePrefix: !isLastRound,
        source: opts.trigger,
        sourceId: runId
      };

      opts.onProgress?.(`Round ${round}/${maxRounds} (${currentTier})...`);

      let response;
      try {
        response = await this.modelRouter.generate(contents, callConfig);
      } catch (err: any) {
        errorMessage = err.message || String(err);
        runStatus = 'FAILED';
        break;
      }

      // Aggregate telemetry
      aggregatedTelemetry.promptTokens += response.telemetry.promptTokens;
      aggregatedTelemetry.cachedTokens += response.telemetry.cachedTokens;
      aggregatedTelemetry.thinkingTokens += response.telemetry.thinkingTokens;
      aggregatedTelemetry.candidatesTokens += response.telemetry.candidatesTokens;
      aggregatedTelemetry.totalTokens += response.telemetry.totalTokens;
      aggregatedTelemetry.durationMs += response.telemetry.durationMs;

      const calls = response.functionCalls || [];
      const finishCall = calls.find(fc => fc.name === FINISH_TOOL_NAME);
      const workCalls = calls.filter(fc => fc.name !== FINISH_TOOL_NAME);

      // The model declared the run finished
      if (finishCall && workCalls.length === 0) {
        finalOutput = this.fromFinish(finishCall.args || {}, opts, toolCallsExecuted, runId);
        break;
      }

      if (workCalls.length > 0 && !isLastRound) {
        // REPETITION GUARD: the exact same calls twice in a row -> make the model finish
        const currentSignatures = workCalls
          .map(fc => `${fc.name}:${JSON.stringify(fc.args || {})}`)
          .sort()
          .join('||');

        if (currentSignatures === lastToolCallSignatures) {
          console.warn(`[UnifiedAgentRunner] Repetition Guard triggered on round ${round} for run ${runId}: forcing finish.`);
          forceFinal = true;
          appendUserNote(contents, REPEAT_NOTE);
          if (round === maxRounds) break;
          continue;
        }
        lastToolCallSignatures = currentSignatures;

        // Save model's call turn into history, preserving thought_signature if available
        const modelCandidateContent = response.rawResponse?.candidates?.[0]?.content;
        if (modelCandidateContent && modelCandidateContent.parts) {
          contents.push({
            role: 'model',
            parts: modelCandidateContent.parts
          });
        } else {
          contents.push({
            role: 'model',
            parts: calls.map(fc => ({
              functionCall: { name: fc.name, args: fc.args }
            }))
          });
        }

        const runCall = async (call: { name: string; args: any }) => {
          const toolStart = Date.now();
          opts.onProgress?.(`Executing tool: ${call.name}...`);
          opts.onToolStart?.(call.name, round);
          try {
            const result = await this.dispatcher.dispatch(call.name, call.args || {}, toolExecutionContext);
            return { result, isError: false, durationMs: Date.now() - toolStart };
          } catch (tErr: any) {
            return { result: { error: tErr.message } as any, isError: true, durationMs: Date.now() - toolStart };
          }
        };

        // Plain reads run in parallel; anything that writes runs afterwards, one at a time, in order
        const isPlainRead = (name: string) => {
          const tool = this.dispatcher.getTool(name);
          return tool?.effectClass === 'READ';
        };
        const outcomes = new Array(workCalls.length);
        await Promise.all(workCalls.map(async (call, i) => {
          if (isPlainRead(call.name)) outcomes[i] = await runCall(call);
        }));
        for (const [i, call] of workCalls.entries()) {
          if (!outcomes[i]) outcomes[i] = await runCall(call);
        }

        const functionResponseParts: any[] = [];
        for (const [i, call] of workCalls.entries()) {
          const { result, isError, durationMs: toolDuration } = outcomes[i];

          if (isError) {
            consecutiveFailures++;
            // Escalation rule: after 2 tool failures, escalate to HIGH thinking
            if (consecutiveFailures >= 2 && currentTier !== 'ESCALATION' && currentTier !== 'ANALYSIS') {
              currentTier = 'ESCALATION';
              opts.onProgress?.('Escalated model tier to HIGH thinking due to tool failures.');
            }
          } else {
            consecutiveFailures = 0;
          }

          // Only a result the Result Store took has a handle; readers echo the handle they read from
          const storedHandle: string | undefined = !isError && result && typeof result === 'object' && result.isStored && result.handle
            ? result.handle
            : undefined;
          if (storedHandle && !handlesCreated.includes(storedHandle)) handlesCreated.push(storedHandle);

          toolCallsExecuted.push({
            tool: call.name,
            params: call.args,
            result,
            durationMs: toolDuration,
            handle: storedHandle,
            notEvidence: isError ? undefined : !this.dispatcher.isEvidence(call.name, call.args || {})
          });

          functionResponseParts.push({
            functionResponse: {
              name: call.name,
              response: { result }
            }
          });
        }

        if (finishCall) {
          // finish alongside work calls was written before seeing the results
          functionResponseParts.push({
            functionResponse: {
              name: FINISH_TOOL_NAME,
              response: { error: 'Not finished: finish must be called alone, after you have reviewed the results above.' }
            }
          });
        }

        // Add function responses as user turn
        contents.push({
          role: 'user',
          parts: functionResponseParts
        });

        continue;
      }

      // No usable finish call: fall back to whatever text the model produced
      finalOutput = this.parseOutput(response.text, opts, toolCallsExecuted, runId);
      break;
    }

    if (!finalOutput) {
      if (errorMessage) {
        console.error(`[UnifiedAgentRunner] Run ${runId} failed:`, errorMessage);
      }
      const fallbackHeadline = stoppedEarlyMessage(runStatus, toolCallsExecuted, errorMessage);
      finalOutput = {
        deliveryMode: 'SLACK_MESSAGE',
        finishStatus: 'BLOCKED',
        coworkerHeadline: fallbackHeadline,
        slackMessage: fallbackHeadline,
        summary: errorMessage || 'Run ended without a final answer.'
      };
    }

    finalOutput = withConfirmations(finalOutput, toolCallsExecuted);

    const runResult: UnifiedRunResult = {
      runId,
      status: runStatus,
      output: finalOutput,
      toolCallsExecuted,
      handlesCreated,
      telemetry: aggregatedTelemetry,
      wallMs: Date.now() - runStartedAt,
      error: errorMessage
    };

    // Record in Glass-Box Run Trace inspector store
    if (this.runTraceStore) {
      try {
        this.runTraceStore.recordRun(opts.trigger, opts.instruction, runResult);
      } catch (traceErr: any) {
        console.warn(`[UnifiedAgentRunner] Failed to record run trace: ${traceErr.message}`);
      }
    }

    return runResult;
  }

  private fromFinish(args: any, opts: UnifiedRunOptions, calls: ToolCallExecutionRecord[], runId?: string): UnifiedAgentOutput {
    const status: FinishStatus = FINISH_STATUSES.includes(args.status) ? args.status : 'DONE';
    let deliveryMode: DeliveryMode = ['REACTION_ONLY', 'SLACK_MESSAGE', 'SILENT'].includes(args.deliveryMode)
      ? args.deliveryMode
      : (status === 'NOTHING_TO_REPORT' ? 'SILENT' : 'SLACK_MESSAGE');

    if (status !== 'DONE' && status !== 'NOTHING_TO_REPORT') deliveryMode = 'SLACK_MESSAGE';
    if (status === 'DONE' && deliveryMode === 'SILENT') deliveryMode = 'SLACK_MESSAGE';
    if (opts.trigger === 'slack_dm' || opts.isInteractive) {
      // Never ghost the owner in a conversation
      if (deliveryMode === 'SILENT' || isUserQuestionOrPing(opts.instruction)) deliveryMode = 'SLACK_MESSAGE';
    }

    const ledgerEntries = runId ? this.dispatcher.getLedgerRepo?.()?.listByRun?.(runId) : undefined;
    const extraEvidenceTexts: string[] = [
      opts.instruction,
      ...((opts.userParts ?? []).map(p => p.text).filter((t): t is string => typeof t === 'string')),
      ...(this.memoryRepo?.getExecutiveFacts() || []).map(f => f.statement)
    ];

    const rawMessage = typeof args.message === 'string' ? args.message.trim() : '';
    const message = groundReply(this.cleanPassiveOffers(rawMessage), calls, ledgerEntries, extraEvidenceTexts)
      || stoppedEarlyMessage('COMPLETED', calls);

    let artifactLink = typeof args.artifactLink === 'string' && args.artifactLink.trim() ? args.artifactLink.trim() : undefined;
    if (artifactLink && groundReply(artifactLink, calls, ledgerEntries, extraEvidenceTexts) !== artifactLink) {
      artifactLink = undefined; // a link no tool returned in this run is not shown
    }

    return {
      deliveryMode,
      finishStatus: status,
      reactionEmoji: args.reactionEmoji || (deliveryMode === 'REACTION_ONLY' ? 'white_check_mark' : undefined),
      coworkerHeadline: message,
      slackMessage: message,
      artifactLink,
      requiresClarification: status === 'NEEDS_INPUT',
      summary: message.slice(0, 200)
    };
  }

  private cleanPassiveOffers(text?: string): string | undefined {
    if (!text) return text;
    return text
      .replace(/would you like me to\s+/gi, 'I can ')
      .replace(/should i go ahead and\s+/gi, 'Ready to ')
      .replace(/let me know if you would like me to\s+/gi, 'Staged to ')
      .replace(/czy chcesz,? żebym\s+/gi, 'Mogę ')
      .replace(/czy mam\s+/gi, 'Gotowe do ');
  }

  private parseOutput(
    rawText: string,
    opts?: UnifiedRunOptions,
    toolCallsExecuted?: ToolCallExecutionRecord[],
    runId?: string
  ): UnifiedAgentOutput {
    const isDirectSlack = opts?.trigger === 'slack_dm' || opts?.isInteractive;
    const isQuestion = isUserQuestionOrPing(opts?.instruction);
    const ledgerEntries = runId ? this.dispatcher.getLedgerRepo?.()?.listByRun?.(runId) : undefined;
    const extraEvidenceTexts: string[] = [
      opts?.instruction ?? '',
      ...((opts?.userParts ?? []).map(p => p.text).filter((t): t is string => typeof t === 'string')),
      ...(this.memoryRepo?.getExecutiveFacts() || []).map(f => f.statement)
    ];

    if (!rawText || !rawText.trim()) {
      if (isQuestion || isDirectSlack) {
        const msg = stoppedEarlyMessage('COMPLETED', toolCallsExecuted ?? []);
        return {
          deliveryMode: 'SLACK_MESSAGE',
          coworkerHeadline: msg,
          slackMessage: msg,
          summary: 'Completed without structured text output.'
        };
      }
      return {
        deliveryMode: 'REACTION_ONLY',
        reactionEmoji: 'white_check_mark',
        summary: 'Completed silently.'
      };
    }

    try {
      const parsed = JSON.parse(rawText);
      let deliveryMode: DeliveryMode = ['REACTION_ONLY', 'SLACK_MESSAGE', 'SILENT'].includes(parsed.deliveryMode)
        ? parsed.deliveryMode
        : 'SLACK_MESSAGE';

      // Never silently drop turns or react-only when expecting a conversational reply
      if (isDirectSlack) {
        if (isQuestion) {
          deliveryMode = 'SLACK_MESSAGE';
        } else if (deliveryMode === 'SILENT') {
          deliveryMode = 'SLACK_MESSAGE';
        }
      }

      const rawTrimmed = rawText.trim();
      const isRawJson = rawTrimmed.startsWith('{') && rawTrimmed.endsWith('}');
      const safeSummary = (parsed.summary && !parsed.summary.trim().startsWith('{'))
        ? parsed.summary
        : (parsed.coworkerHeadline || (isRawJson ? 'Execution completed.' : rawText.slice(0, 150)));

      let headline = this.cleanPassiveOffers(parsed.coworkerHeadline);
      let slackMsg = this.cleanPassiveOffers(parsed.slackMessage || headline);

      if (deliveryMode === 'SLACK_MESSAGE' && (!headline || !headline.trim())) {
        if (parsed.summary && !parsed.summary.trim().startsWith('{')) {
          headline = this.cleanPassiveOffers(parsed.summary);
          slackMsg = headline;
        } else {
          headline = stoppedEarlyMessage('COMPLETED', toolCallsExecuted ?? []);
          slackMsg = headline;
        }
      }

      if (deliveryMode === 'SLACK_MESSAGE') {
        slackMsg = groundReply(slackMsg, toolCallsExecuted ?? [], ledgerEntries, extraEvidenceTexts);
        headline = groundReply(headline, toolCallsExecuted ?? [], ledgerEntries, extraEvidenceTexts);
      }

      return {
        deliveryMode,
        reactionEmoji: parsed.reactionEmoji || (deliveryMode === 'REACTION_ONLY' ? 'white_check_mark' : undefined),
        coworkerHeadline: headline,
        slackMessage: slackMsg,
        artifactLink: parsed.artifactLink,
        requiresClarification: Boolean(parsed.requiresClarification),
        summary: safeSummary
      };
    } catch {
      // Fallback for non-JSON text output
      return {
        deliveryMode: 'SLACK_MESSAGE',
        coworkerHeadline: groundReply(this.cleanPassiveOffers(rawText), toolCallsExecuted ?? [], ledgerEntries, extraEvidenceTexts),
        slackMessage: groundReply(this.cleanPassiveOffers(rawText), toolCallsExecuted ?? [], ledgerEntries, extraEvidenceTexts),
        summary: rawText.slice(0, 150)
      };
    }
  }
}
