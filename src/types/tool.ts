import { z } from 'zod';

export type EffectClass =
  | 'READ'
  | 'LOCAL_WRITE'
  | 'INTERNAL_REVERSIBLE_WRITE'
  | 'CONSEQUENTIAL';

export interface SlackOrigin {
  channel: string;
  threadTs?: string;
  user?: string;
  isDirectMessage?: boolean;
}

export const COMMAND_AND_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'routine_manage',
  'reminder_manage',
  'nudge_settings_manage',
  'memory_manage',
  'queue_manage',
  'workspace_alias_manage',
  'sentinel_manage',
  'cost_and_budget_manage'
]);

export interface ToolGrant {
  allowedToolNames: Set<string>;
  allowConsequential: boolean;
}

export interface ToolExecutionContext {
  runId: string;
  isInteractive: boolean;
  toolGrant: ToolGrant;
  slackOrigin?: SlackOrigin;
  batchId?: string;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Results of READ calls already made in this run, keyed by tool + params. Created once per run by the runner. */
  readMemo?: Map<string, any>;
  /** Text this run has seen (the owner's own words, every tool result). Identity details in owner text may be grounded in it. */
  evidence?: string[];
  /** Set by the dispatcher once a tool that provides the owner's sources succeeded in this run. */
  ownerSourcesRead?: boolean;
  /** Subtask nesting depth (0 for root runs, 1 for subtasks). Subtasks cannot delegate further. */
  subtaskDepth?: number;
  /** Recent images attached to this interaction or conversation thread (base64 and mimeType). */
  recentImages?: Array<{ mimeType: string; data: string; name?: string }>;
}

export type RunContext = ToolExecutionContext;

/**
 * 'message': written in the owner's name to someone else (drafts, sends): Claims Bank figures and identity details.
 * 'document': a document the owner will use or share: identity details.
 */
export type OwnerTextKind = 'message' | 'document';

export type VerificationStatus = 'VERIFIED' | 'ABSENT' | 'INCONCLUSIVE' | 'UNAVAILABLE';

export interface ToolDefinition<TParams = any, TResult = any> {
  name: string;
  description: string;
  schema: z.ZodType<TParams>;
  effectClass: EffectClass;
  /** False when the backing integration is not configured; the tool is then not declared to the model. */
  isAvailable?: () => boolean;
  readsBackInline?: boolean;
  /**
   * Declares the text this tool writes for the owner; the dispatcher checks it before anything is written or staged.
   * field names the parameter that carries the body: it may hold a draft handle (see keepsDraft) instead of the text.
   */
  ownerText?: { kind: OwnerTextKind; text: (params: TParams) => string; field?: string };
  /**
   * The dispatcher keeps this text under a handle (draftHandle on the result), so a write can name the handle in its
   * ownerText field instead of the model generating the same draft again. The kept text is never evidence.
   */
  keepsDraft?: (params: TParams) => string;
  /** True for calls that read the owner's own sources in full; owner text is refused until a run has made one. */
  providesOwnerSources?: (params: TParams) => boolean;
  /**
   * The result is not a source: it repeats text the model or Ellie wrote (a draft check, her own run
   * traces, her code). It never counts as evidence that grounds identity details, and neither does a
   * later result_read of it.
   */
  notEvidence?: boolean;
  /** The resource (Doc, file) this call created with text Ellie wrote. Later reads of it are not evidence. */
  writesResource?: (params: TParams, result: TResult) => string | undefined;
  /** The resource this read returns. If Ellie wrote it (writesResource), the result is not evidence. */
  readsResource?: (params: TParams) => string | undefined;
  /** The model needs all of this result to do the job: it stays inline up to FULL_RESULT_MAX_CHARS instead of going to the Result Store. */
  keepsFullResult?: boolean;
  execute: (params: TParams, context: ToolExecutionContext) => Promise<TResult>;
  verify?: (params: TParams, result: TResult) => Promise<{
    outcome: 'VERIFIED_SUCCESS' | 'FAILED_SAFE' | 'RECONCILIATION_REQUIRED';
    details?: string;
    reconciliationNotes?: string;
  }>;
  reconcile?: (params: TParams, result: TResult) => Promise<{
    outcome: 'VERIFIED_SUCCESS' | 'FAILED_SAFE' | 'RECONCILIATION_REQUIRED';
    details?: string;
    reconciliationNotes?: string;
  }>;
}
