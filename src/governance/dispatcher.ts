import { ToolDefinition, ToolExecutionContext, ToolGrant, EffectClass, VerificationStatus, COMMAND_AND_CONTROL_TOOL_NAMES } from '../types/tool.js';
import { ActionLedgerRepository } from '../storage/action-ledger.js';
import { ResultStore, RESULT_READER_TOOLS } from '../storage/result-store.js';
import { slimForModel } from './slim.js';
import { OWNER_NAME } from '../config/owner.js';
import { ClaimsGuard, reviewOwnerText } from './claims-bank.js';
import { AuthoredResources } from '../storage/authored-resources.js';

const EVIDENCE_CHARS_PER_RESULT = 200_000;
/** Upper bound for a result a tool marks keepsFullResult; anything larger still goes to the Result Store. */
export const FULL_RESULT_MAX_CHARS = 48_000;

/** Plain text of a tool result, for grounding identity details later in the run. */
function evidenceText(result: any): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result) ?? '';
  return text.slice(0, EVIDENCE_CHARS_PER_RESULT);
}

const REPEATED_CALL_NOTE = 'You already made this exact call in this run; this is the same result. Answer from it, or change the parameters.';

/** JSON with sorted keys, so {a,b} and {b,a} are the same call. */
function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const MAIL_HEADER_LINE = /^(subject|to|cc|bcc|from)\s*:/i;

/**
 * A mail body never repeats the headers the write carries as their own fields: a draft checked as
 * "Subject: ...\n\nHi ..." and then written by handle would otherwise send the subject twice.
 */
export function stripRepeatedHeaders(tool: ToolDefinition | undefined, rawParams: unknown): unknown {
  if (!rawParams || typeof rawParams !== 'object') return rawParams;
  const params = rawParams as any;
  const field = tool?.ownerText?.field ?? (['body', 'bodyText', 'text'].find(k => typeof params[k] === 'string'));
  if (!field) return rawParams;
  if (typeof params.subject !== 'string' || typeof params[field] !== 'string') return rawParams;
  const lines = params[field].split('\n');
  const subject = params.subject.trim();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === '' || MAIL_HEADER_LINE.test(line) || (subject && line === subject)) i++;
    else break;
  }
  if (i === 0 || i === lines.length) return rawParams;
  return { ...params, [field]: lines.slice(i).join('\n') };
}

export const OUTWARD_COMMUNICATION_TOOLS = new Set([
  'gmail_send',
  'gmail_draft',
  'proton_send',
  'proton_draft',
  'slack_post_message'
]);

export function extractOutwardTarget(toolName: string, rawParams: unknown): { recipient: string; subject: string } | null {
  if (!rawParams || typeof rawParams !== 'object') return null;
  const params = rawParams as Record<string, any>;
  if (toolName === 'gmail_send' || toolName === 'gmail_draft' || toolName === 'proton_send' || toolName === 'proton_draft') {
    const to = String(params.to || '').toLowerCase().trim();
    const subject = String(params.subject || '')
      .toLowerCase()
      .replace(/^(re|fwd):\s*/i, '')
      .trim();
    if (!to && !subject) return null;
    return { recipient: to, subject };
  }
  if (toolName === 'slack_post_message') {
    const recipient = String(params.channel || params.user || '').toLowerCase().trim();
    const text = String(params.text || '').substring(0, 80).toLowerCase().trim();
    if (!recipient && !text) return null;
    return { recipient, subject: text };
  }
  return null;
}

export interface ReadBackResult {
  status: VerificationStatus;
  detail: string;
}

export class ToolDispatcher {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly ledgerRepo?: ActionLedgerRepository,
    private readonly resultStore?: ResultStore,
    private readonly claimsGuard?: ClaimsGuard,
    private readonly authoredResources?: AuthoredResources
  ) {}

  /**
   * Whether this call's result may ground claims in owner text. Not when it repeats Ellie's own text:
   * a tool marked notEvidence, a read of a resource Ellie wrote, or a result_read of such a result
   * (from this run or an earlier one). Any tool, any trigger.
   */
  public isEvidence(toolName: string, params: any): boolean {
    const tool = this.tools.get(toolName);
    if (!tool || tool.notEvidence) return false;
    const resource = tool.readsResource?.(params);
    if (resource && this.authoredResources?.has(resource)) return false;
    if (RESULT_READER_TOOLS.has(toolName) && typeof params?.handle === 'string') {
      return this.resultStore?.isEvidence(params.handle) ?? false;
    }
    return true;
  }

  public registerTool(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  public upsertTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Tools the model should see: granted and backed by a configured integration. */
  public getDeclaredTools(grant?: ToolGrant): ToolDefinition[] {
    return this.getAllTools().filter(t =>
      (t.isAvailable?.() ?? true) && (!grant || grant.allowedToolNames.has(t.name))
    );
  }

  public getAllTools(): ToolDefinition[] {
    // Sort deterministically by name for byte-stable prompt prefix caching
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  public getLedgerRepo(): ActionLedgerRepository | undefined {
    return this.ledgerRepo;
  }

  public getResultStore(): ResultStore | undefined {
    return this.resultStore;
  }

  public getClaimsGuard(): ClaimsGuard | undefined {
    return this.claimsGuard;
  }

  public async dispatch<TParams = any, TResult = any>(
    toolName: string,
    rawParams: unknown,
    context: ToolExecutionContext
  ): Promise<TResult> {
    // 1. Tool existence check (Fail Closed)
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`[Security Refusal] Tool '${toolName}' does not exist on this server.`);
    }

    // 2. Explicit tool grant whitelist check (Principle P1 & P4)
    if (!context.toolGrant.allowedToolNames.has(toolName)) {
      throw new Error(`[Security Refusal] Tool '${toolName}' is not granted to this execution run (Run ID: ${context.runId}).`);
    }

    // 2.5 Security Guardrail: Command & Control tools reserved exclusively for INTERACTIVE_SLACK
    if (COMMAND_AND_CONTROL_TOOL_NAMES.has(toolName)) {
      if (!context.isInteractive || context.slackOrigin?.isDirectMessage !== true) {
        throw new Error(
          `[Security Refusal] Tool '${toolName}' is a Command & Control management tool and can ONLY be executed in INTERACTIVE_SLACK sessions by the owner.`
        );
      }
    }

    // 3. Effect class is declared by the tool (every tool is native and reviewed in this repo)
    const effectClass: EffectClass = tool.effectClass;

    // 3a. A write may name a checked draft by handle instead of the model generating it again (any owner-text tool).
    rawParams = this.resolveDraftHandle(tool, rawParams);
    rawParams = stripRepeatedHeaders(tool, rawParams);

    // 3b. Text written for the owner is checked before anything is staged or written (any tool that declares it).
    if (tool.ownerText) {
      await this.guardOwnerText(tool, tool.schema.parse(rawParams), context, 'run');
    }

    // 4. Consequential effect protection (Principle P2 & P6)
    if (effectClass === 'CONSEQUENTIAL') {
      // Staging never executes anything. Interactive runs need allowConsequential;
      // background routines may only stage into their batch for review in /queue.
      const mayStage = context.isInteractive ? context.toolGrant.allowConsequential : Boolean(context.batchId);
      if (!mayStage) {
        throw new Error(
          `[Security Refusal] Tool '${toolName}' has effect class CONSEQUENTIAL and cannot run autonomously in scheduled or background tasks (Principle P6).`
        );
      }

      if (!this.ledgerRepo) {
        throw new Error(`[Security Refusal] Action Ledger repository required to stage consequential tool '${toolName}'.`);
      }
    }

    // 4b. Outward action deduplication: prevent duplicate proposals within 24 hours (§47)
    if (this.ledgerRepo && OUTWARD_COMMUNICATION_TOOLS.has(toolName)) {
      const target = extractOutwardTarget(toolName, rawParams);
      if (target && target.recipient && target.subject) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentActions = this.ledgerRepo.findRecentOutwardActions(Array.from(OUTWARD_COMMUNICATION_TOOLS), since);
        for (const recent of recentActions) {
          try {
            const recentPayload = JSON.parse(recent.payload_json);
            const recentTarget = extractOutwardTarget(recent.action_type, recentPayload);
            if (recentTarget && recentTarget.recipient === target.recipient && recentTarget.subject === target.subject) {
              throw new Error(
                `[Duplicate Action Refusal] An identical or matching outward action to '${target.recipient}' with subject/target '${target.subject}' was already staged or executed within the last 24 hours (Action ID: ${recent.id}, State: ${recent.state}).`
              );
            }
          } catch (err: any) {
            if (err.message.startsWith('[Duplicate Action Refusal]')) throw err;
          }
        }
      }
    }

    if (effectClass === 'CONSEQUENTIAL') {
      const validatedParams = tool.schema.parse(rawParams);
      const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      const stagedRecord = this.ledgerRepo!.stageProposal({
        actionId,
        actionType: toolName,
        payload: validatedParams as Record<string, any>,
        originRunId: context.runId,
        slackChannel: context.slackOrigin?.channel,
        slackThreadTs: context.slackOrigin?.threadTs,
        batchId: context.batchId
      });

      return {
        status: 'STAGED_FOR_APPROVAL',
        actionId: stagedRecord.id,
        message: `Action '${toolName}' staged for approval (ID: ${stagedRecord.id}). Awaiting ${OWNER_NAME}'s confirmation.`,
        payload: JSON.parse(stagedRecord.payload_json),
        expiresAt: stagedRecord.expires_at,
        batchId: stagedRecord.batch_id
      } as TResult;
    }

    // 5. Schema validation for Read / Local / Reversible tools
    const validatedParams = tool.schema.parse(rawParams);

    // 5b. The same read twice in one run never hits the provider again (any tool, any trigger).
    // Any write may change what a read returns, so it empties the memo.
    if (effectClass !== 'READ') context.readMemo?.clear();
    const memoKey = effectClass === 'READ' && context.readMemo ? `${toolName}:${stableStringify(validatedParams)}` : undefined;
    if (memoKey && context.readMemo!.has(memoKey)) {
      const earlier = context.readMemo!.get(memoKey);
      return (earlier && typeof earlier === 'object' && !Array.isArray(earlier)
        ? { ...earlier, repeatedCall: REPEATED_CALL_NOTE }
        : { result: earlier, repeatedCall: REPEATED_CALL_NOTE }) as TResult;
    }

    // 6. Execute deterministic tool implementation
    let result = await tool.execute(validatedParams, context);
    this.recordAuthored(tool, validatedParams, result, context.runId);

    // Record non-consequential outward actions (e.g. slack_post_message) in ledger for 24h deduplication
    if (this.ledgerRepo && OUTWARD_COMMUNICATION_TOOLS.has(toolName)) {
      try {
        const actionId = `act_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const record = this.ledgerRepo.stageProposal({
          actionId,
          actionType: toolName,
          payload: validatedParams as Record<string, any>,
          originRunId: context.runId,
          slackChannel: context.slackOrigin?.channel,
          slackThreadTs: context.slackOrigin?.threadTs
        });
        this.ledgerRepo.claimForExecution(record.id, 'dispatcher');
        this.ledgerRepo.markProviderConfirmed(record.id, 'dispatcher');
      } catch {}
    }

    const isEvidence = this.isEvidence(toolName, validatedParams);
    if (isEvidence) context.evidence?.push(evidenceText(result));
    if (tool.providesOwnerSources?.(validatedParams)) context.ownerSourcesRead = true;

    // 6b. Every read result loses API envelope noise (etags, kinds, base64, nulls) before the model sees it.
    if (effectClass === 'READ') result = slimForModel(result);

    // 6c. A checked draft is kept under a handle, so the write names it instead of re-sending the text.
    if (tool.keepsDraft && this.resultStore && result && typeof result === 'object' && !Array.isArray(result)) {
      const draftHandle = this.resultStore.keep(context.runId, toolName, tool.keepsDraft(validatedParams), { notEvidence: true });
      result = {
        ...result,
        draftHandle,
        useDraft: `To write exactly this text, pass '${draftHandle}' as the text field of the write (body, bodyText or text) instead of the text. If you change the text, send the new text instead.`
      } as any;
    }

    // 7. Large results go to the Result Store; reading the store is never stored again.
    const keepInline = tool.keepsFullResult && (JSON.stringify(result) ?? '').length <= FULL_RESULT_MAX_CHARS;
    if (this.resultStore && !RESULT_READER_TOOLS.has(toolName) && !keepInline) {
      const intercepted = this.resultStore.intercept(context.runId, toolName, result, { notEvidence: !isEvidence });
      if (intercepted.isStored) {
        result = intercepted as any;
      }
    }

    if (memoKey) context.readMemo!.set(memoKey, result);

    // 8. Read-back verification for reversible writes
    if (effectClass === 'INTERNAL_REVERSIBLE_WRITE') {
      return (await this.attachReadBack(tool, validatedParams, result, context)) as TResult;
    }

    return result;
  }

  /**
   * Runs an owner-approved action through the tool's own execute(), so tool-level
   * guards (Claims Bank etc.) apply. Only the approval executor calls this.
   */
  public async executeApproved(actionType: string, payload: unknown, context: ToolExecutionContext): Promise<{ result: any; readBack?: ReadBackResult }> {
    const tool = this.tools.get(actionType);
    if (!tool) {
      throw new Error(`Unsupported action type '${actionType}'`);
    }
    const params = tool.schema.parse(payload);
    if (tool.ownerText) await this.guardOwnerText(tool, params, context, 'approved');
    const result = await tool.execute(params, context);
    this.recordAuthored(tool, params, result, context.runId);
    if (!tool.verify && !tool.reconcile) {
      return { result };
    }
    const annotated = await this.attachReadBack(tool, params, result, context);
    return { result, readBack: annotated.readBack };
  }

  /**
   * Refuses owner text with unsourced claims. Messages are checked against the Claims Bank;
   * every kind is checked for identity details. An approved action was identity-checked when it
   * was staged and the owner approved that exact text, so only the Claims Bank is re-checked then.
   */
  private async guardOwnerText(tool: ToolDefinition, params: any, context: ToolExecutionContext, mode: 'run' | 'approved'): Promise<void> {
    const text = tool.ownerText!.text(params);
    if (!this.claimsGuard) {
      throw new Error(`[Claims Refusal] '${tool.name}' writes text for ${OWNER_NAME}, but no claims guard is configured.`);
    }
    // Writing for the owner starts from the owner's sources, not from memory (any tool, any trigger).
    if (mode === 'run' && !context.ownerSourcesRead) {
      const providers = this.getAllTools().filter(t => t.providesOwnerSources).map(t => t.name);
      if (providers.length > 0) {
        throw new Error(
          `[Claims Refusal] Nothing was written by '${tool.name}'. Read ${OWNER_NAME}'s sources first: call ${providers.join(' or ')}, ` +
          `read the Docs that hold the facts, contact details and writing rules for this, then write again using only what they support.`
        );
      }
    }
    const { refusals } = await reviewOwnerText(this.claimsGuard, tool.ownerText!.kind, text, { evidence: context.evidence, identity: mode === 'run' });
    if (refusals.length > 0) {
      throw new Error(`[Claims Refusal] Nothing was written by '${tool.name}'. ${refusals.join(' | ')}`);
    }
  }

  /** Replaces a draft handle in a tool's owner-text field with the draft it stands for; unknown handles fail closed. */
  private resolveDraftHandle(tool: ToolDefinition, rawParams: unknown): unknown {
    const field = tool.ownerText?.field;
    if (!field || !rawParams || typeof rawParams !== 'object') return rawParams;
    const value = (rawParams as any)[field];
    if (typeof value !== 'string' || !/^res_[A-Za-z0-9_]+$/.test(value.trim())) return rawParams;
    const record = this.resultStore?.get(value.trim());
    if (!record || !this.tools.get(record.tool_name)?.keepsDraft) {
      throw new Error(`[Draft Refusal] Nothing was written by '${tool.name}': '${value.trim()}' is not a checked draft. Send the full text in '${field}'.`);
    }
    let resolvedContent: any = record.content;
    if (field === 'blocks' || (typeof record.content === 'string' && record.content.trim().startsWith('['))) {
      try {
        resolvedContent = JSON.parse(record.content);
      } catch {}
    }
    return { ...(rawParams as any), [field]: resolvedContent };
  }

  private recordAuthored(tool: ToolDefinition, params: any, result: any, runId: string): void {
    if (!tool.writesResource || !this.authoredResources) return;
    if (result && typeof result === 'object' && result.status === 'STAGED_FOR_APPROVAL') return;
    const id = tool.writesResource(params, result);
    if (id) this.authoredResources.record(id, tool.name, runId);
  }

  private async attachReadBack(tool: ToolDefinition, params: any, result: any, context: ToolExecutionContext): Promise<any> {
    if (result && typeof result === 'object' && result.status === 'STAGED_FOR_APPROVAL') {
      return result;
    }

    let readBack: ReadBackResult = { status: 'UNAVAILABLE', detail: `No read-back hook configured for '${tool.name}'.` };

    if (tool.readsBackInline) {
      readBack = { status: 'VERIFIED', detail: 'Read back inline by tool.' };
    } else if (tool.verify || tool.reconcile) {
      try {
        const checker = tool.verify || tool.reconcile;
        const outcome = await checker!(params, result);
        if (outcome.outcome === 'VERIFIED_SUCCESS') {
          readBack = { status: 'VERIFIED', detail: outcome.details || 'Read back successfully.' };
        } else if (outcome.outcome === 'FAILED_SAFE') {
          readBack = { status: 'ABSENT', detail: outcome.details || 'Read-back did not find the write.' };
        } else {
          readBack = { status: 'INCONCLUSIVE', detail: outcome.reconciliationNotes || outcome.details || 'Inconclusive read-back.' };
        }
      } catch (err: any) {
        readBack = { status: 'INCONCLUSIVE', detail: `Read-back failed: ${err.message}` };
      }
    }

    const annotated: Record<string, any> = (result && typeof result === 'object' && !Array.isArray(result))
      ? { ...result, readBack }
      : { result, readBack };

    if (readBack.status === 'ABSENT') {
      annotated.warning = 'The write reported success, but reading it back shows it did not take effect. Do not report it as done.';
    } else if (readBack.status !== 'VERIFIED') {
      annotated.warning = 'The write was accepted but could not be read back. Report it as unverified, not as done.';
    }

    return annotated;
  }
}
