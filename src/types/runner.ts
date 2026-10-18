export type DeliveryMode = 'REACTION_ONLY' | 'SLACK_MESSAGE' | 'SILENT';

/** How the run ended, as declared by the model through the finish tool. */
export type FinishStatus = 'DONE' | 'NEEDS_INPUT' | 'BLOCKED' | 'NOTHING_TO_REPORT' | 'CONTINUE_IN_BACKGROUND';

export interface UnifiedAgentOutput {
  deliveryMode: DeliveryMode;
  finishStatus?: FinishStatus;
  reactionEmoji?: string;
  coworkerHeadline?: string;
  slackMessage?: string;
  artifactLink?: string;
  requiresClarification?: boolean;
  summary?: string;
}

export interface TokenTelemetry {
  promptTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  model: string;
  durationMs: number;
}

export interface ToolCallExecutionRecord {
  tool: string;
  params: any;
  result: any;
  durationMs: number;
  handle?: string;
  /** The result repeats Ellie's own text; kept with it when carried to a later run (dispatcher.isEvidence). */
  notEvidence?: boolean;
}

export interface UnifiedRunResult {
  runId: string;
  status: 'COMPLETED' | 'FAILED' | 'TIMEOUT';
  output: UnifiedAgentOutput;
  toolCallsExecuted: ToolCallExecutionRecord[];
  handlesCreated: string[];
  /** Summed model-call time only; telemetry.durationMs. */
  telemetry: TokenTelemetry;
  /** Wall-clock time of the whole run: model calls, tool calls and everything between. */
  wallMs: number;
  error?: string;
}
