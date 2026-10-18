import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { ActionLedgerRecord, ActionState, StageProposalInput } from '../types/action.js';

export function canonicalJsonString(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonString).join(',') + ']';
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalJsonString((obj as any)[k])}`).join(',') + '}';
}

export function computePayloadHash(payload: unknown): string {
  const canonical = canonicalJsonString(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export class ActionLedgerRepository {
  constructor(private readonly db: DatabaseSync) {}

  public stageProposal(input: StageProposalInput): ActionLedgerRecord {
    const actionId = input.actionId || `act_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const payloadJson = JSON.stringify(input.payload);
    const payloadHash = computePayloadHash(input.payload);
    const expiryMinutes = input.expiryMinutes || parseInt(process.env.ELLIE_APPROVAL_EXPIRY_MINUTES || '', 10) || 30;
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO action_ledger (
        id, action_type, payload_json, payload_hash, state,
        created_at, updated_at, expires_at,
        origin_run_id, slack_channel, slack_thread_ts, batch_id
      ) VALUES (?, ?, ?, ?, 'STAGED', ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      actionId,
      input.actionType,
      payloadJson,
      payloadHash,
      now,
      now,
      expiresAt,
      input.originRunId || null,
      input.slackChannel || null,
      input.slackThreadTs || null,
      input.batchId || null
    );

    this.recordEvent(actionId, 'STAGED', 'STAGED', 'system', 'Staged for approval', payloadJson);

    return this.get(actionId)!;
  }

  public updateStagedPayload(actionId: string, newPayload: Record<string, any>, actor = 'owner'): ActionLedgerRecord {
    const existing = this.get(actionId);
    if (!existing) throw new Error(`Action '${actionId}' not found.`);
    if (existing.state !== 'STAGED') {
      throw new Error(`Cannot update action '${actionId}': state is '${existing.state}', expected 'STAGED'.`);
    }

    const payloadJson = JSON.stringify(newPayload);
    const payloadHash = computePayloadHash(newPayload);
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET payload_json = ?, payload_hash = ?, updated_at = ?
      WHERE id = ? AND state = 'STAGED'
    `);
    stmt.run(payloadJson, payloadHash, now, actionId);

    this.recordEvent(actionId, 'STAGED', 'STAGED', actor, 'Payload updated in place', payloadJson);

    return this.get(actionId)!;
  }

  public updateProposalArgs(actionId: string, newPayload: Record<string, any>, actor = 'owner'): ActionLedgerRecord {
    return this.updateStagedPayload(actionId, newPayload, actor);
  }

  public approveAction(actionId: string, actor = 'owner'): ActionLedgerRecord {
    const existing = this.get(actionId);
    if (!existing) throw new Error(`Action '${actionId}' not found.`);
    if (existing.state !== 'STAGED') {
      throw new Error(`Cannot approve action '${actionId}': state is '${existing.state}'.`);
    }
    if (new Date(existing.expires_at).getTime() < Date.now()) {
      throw new Error(`Action '${actionId}' has expired.`);
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'APPROVED', approved_at = ?, updated_at = ?
      WHERE id = ? AND state = 'STAGED'
    `);
    stmt.run(now, now, actionId);

    this.recordEvent(actionId, 'STAGED', 'APPROVED', actor, 'Approved by owner');

    return this.get(actionId)!;
  }

  public denyAction(actionId: string, actor = 'owner', reason = 'Dropped by owner'): ActionLedgerRecord {
    const existing = this.get(actionId);
    if (!existing) throw new Error(`Action '${actionId}' not found.`);
    if (existing.state !== 'STAGED' && existing.state !== 'APPROVED') {
      throw new Error(`Cannot deny action '${actionId}': state is '${existing.state}'.`);
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'DENIED', updated_at = ?, last_error = ?
      WHERE id = ?
    `);
    stmt.run(now, reason, actionId);

    this.recordEvent(actionId, existing.state, 'DENIED', actor, reason);

    return this.get(actionId)!;
  }

  public claimForExecution(actionId: string, actor = 'executor'): boolean {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'EXECUTING', executed_at = ?, updated_at = ?, execution_attempts = execution_attempts + 1
      WHERE id = ? AND state = 'APPROVED'
    `);
    const result = stmt.run(now, now, actionId);
    if (result.changes > 0) {
      this.recordEvent(actionId, 'APPROVED', 'EXECUTING', actor, 'Claimed for execution');
      return true;
    }
    return false;
  }

  public confirmProvider(actionId: string, actor = 'executor'): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'PROVIDER_CONFIRMED', updated_at = ?
      WHERE id = ? AND state = 'EXECUTING'
    `);
    stmt.run(now, actionId);
    this.recordEvent(actionId, 'EXECUTING', 'PROVIDER_CONFIRMED', actor, 'Provider confirmed execution');
  }

  public markProviderConfirmed(actionId: string, actor = 'executor'): void {
    this.confirmProvider(actionId, actor);
  }

  public markVerified(actionId: string, actor = 'verifier'): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'VERIFIED', verified_at = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, now, actionId);
    this.recordEvent(actionId, 'PROVIDER_CONFIRMED', 'VERIFIED', actor, 'Read-back verified effect in world');
  }

  public markFailedSafe(actionId: string, error: string, actor = 'executor'): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'FAILED_SAFE', last_error = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(error, now, actionId);
    this.recordEvent(actionId, 'EXECUTING', 'FAILED_SAFE', actor, error);
  }

  public markReconciliationRequired(actionId: string, error: string, actor = 'executor'): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE action_ledger
      SET state = 'RECONCILIATION_REQUIRED', last_error = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(error, now, actionId);
    this.recordEvent(actionId, 'EXECUTING', 'RECONCILIATION_REQUIRED', actor, error);
  }

  public updateSlackCardTs(actionId: string, cardTs: string): void {
    const stmt = this.db.prepare(`
      UPDATE action_ledger SET slack_card_ts = ? WHERE id = ?
    `);
    stmt.run(cardTs, actionId);
  }

  public get(id: string): ActionLedgerRecord | null {
    const stmt = this.db.prepare('SELECT * FROM action_ledger WHERE id = ?');
    const res = stmt.get(id);
    return (res ? (res as unknown as ActionLedgerRecord) : null);
  }

  /** Actions of these types that were claimed for execution since the given time (sent or attempted). */
  public countExecutedSince(actionTypes: string[], since: Date): number {
    if (actionTypes.length === 0) return 0;
    const placeholders = actionTypes.map(() => '?').join(', ');
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM action_ledger
      WHERE action_type IN (${placeholders}) AND executed_at IS NOT NULL AND executed_at >= ?
    `).get(...actionTypes, since.toISOString()) as { n: number };
    return Number(row?.n ?? 0);
  }

  /** Finds staged, approved, or executed outward actions within the given window. */
  public findRecentOutwardActions(actionTypes: string[], since: Date): ActionLedgerRecord[] {
    if (actionTypes.length === 0) return [];
    const placeholders = actionTypes.map(() => '?').join(', ');
    const activeStates = ['STAGED', 'APPROVED', 'EXECUTING', 'PROVIDER_CONFIRMED', 'VERIFIED'];
    const statePlaceholders = activeStates.map(() => '?').join(', ');
    const sql = `
      SELECT * FROM action_ledger
      WHERE action_type IN (${placeholders})
        AND state IN (${statePlaceholders})
        AND created_at >= ?
      ORDER BY created_at DESC
    `;
    return this.db.prepare(sql).all(...actionTypes, ...activeStates, since.toISOString()) as unknown as ActionLedgerRecord[];
  }

  public listStagedByRun(runId: string): ActionLedgerRecord[] {
    return this.db.prepare(`
      SELECT * FROM action_ledger
      WHERE origin_run_id = ? AND state = 'STAGED'
      ORDER BY created_at ASC
    `).all(runId) as unknown as ActionLedgerRecord[];
  }

  public listByRun(runId: string): ActionLedgerRecord[] {
    return this.db.prepare(`
      SELECT * FROM action_ledger
      WHERE origin_run_id = ?
      ORDER BY created_at ASC
    `).all(runId) as unknown as ActionLedgerRecord[];
  }

  public getLatestStagedByThreadTs(threadTs: string): ActionLedgerRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM action_ledger
      WHERE slack_thread_ts = ? AND state = 'STAGED'
      ORDER BY created_at DESC LIMIT 1
    `);
    const res = stmt.get(threadTs);
    return (res ? (res as unknown as ActionLedgerRecord) : null);
  }

  public listStaged(batchId?: string): ActionLedgerRecord[] {
    if (batchId) {
      const stmt = this.db.prepare(`
        SELECT * FROM action_ledger
        WHERE state = 'STAGED' AND batch_id = ?
        ORDER BY created_at DESC
      `);
      return stmt.all(batchId) as unknown as ActionLedgerRecord[];
    }
    const stmt = this.db.prepare(`
      SELECT * FROM action_ledger
      WHERE state = 'STAGED'
      ORDER BY created_at DESC
    `);
    return stmt.all() as unknown as ActionLedgerRecord[];
  }

  public listRecent(limit = 50): ActionLedgerRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM action_ledger
      ORDER BY created_at DESC LIMIT ?
    `);
    return stmt.all(limit) as unknown as ActionLedgerRecord[];
  }

  public dropAction(actionId: string, actor = 'slack:owner', reason = 'Dropped via queue_manage'): ActionLedgerRecord {
    return this.denyAction(actionId, actor, reason);
  }

  public dropBatch(batchId: string, actor = 'slack:owner', reason = 'Batch dropped via queue_manage'): number {
    const staged = this.listStaged(batchId);
    let droppedCount = 0;
    for (const a of staged) {
      this.denyAction(a.id, actor, reason);
      droppedCount++;
    }
    return droppedCount;
  }

  public clearStale(maxAgeHours = 24, actor = 'slack:owner'): number {
    const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
    const stmt = this.db.prepare(`
      SELECT id FROM action_ledger
      WHERE state = 'STAGED' AND (created_at <= ? OR expires_at <= datetime('now'))
    `);
    const stale = stmt.all(cutoff) as Array<{ id: string }>;
    let count = 0;
    for (const row of stale) {
      this.denyAction(row.id, actor, 'Expired or cleared stale staged action');
      count++;
    }
    return count;
  }

  private recordEvent(actionId: string, fromState: ActionState, toState: ActionState, actor: string, reason?: string, data?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO action_ledger_events (action_id, from_state, to_state, actor, reason, event_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(actionId, fromState, toState, actor, reason || null, data || null);
  }
}
