import { DatabaseSync } from 'node:sqlite';

export interface RoutineRecord {
  id: string;
  title: string;
  description?: string | null;
  cron_schedule: string;
  timezone: string;
  is_active: number;
  destination?: string | null;
  cadence_description?: string | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_run_trace_id?: string | null;
  next_run_at?: string | null;
  default_grant?: string | null; // JSON array of string tool names
  hard_constraints?: string | null; // JSON array of strings
  rules?: string | null; // JSON array of strings
  allow_silence?: number | null;
  primary_model?: string | null;
  evaluator_model?: string | null;
  last_run_note?: string | null;
  running_since?: string | null;
  created_at: string;
}

export interface SentinelRecord {
  id: string;
  is_active: number;
  last_check_at?: string | null;
  state_json?: string | null;
}

export interface SentinelSenderRule {
  id: number;
  sentinel_id: string;
  rule_type: 'vip' | 'ignore';
  pattern: string;
  reason?: string | null;
  created_at: string;
}

export function formatCronSchedule(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts;
  const pad = (n: string) => n.padStart(2, '0');
  const timeStr = `${pad(hour)}:${pad(min)}`;

  const dayMap: Record<string, string> = {
    '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun'
  };

  if (dow === '*' && dom === '*' && mon === '*') {
    return `Daily ${timeStr}`;
  }
  if (dow === '1-5') {
    return `Mon-Fri ${timeStr}`;
  }
  if (dow.includes(',')) {
    const days = dow.split(',').map(d => dayMap[d] || d).join(', ');
    return `${days} ${timeStr}`;
  }
  if (dayMap[dow]) {
    return `${dayMap[dow]} ${timeStr}`;
  }
  return cron;
}

/** Routines live only in SQLite; they are created and edited from Slack (routine_manage). */
export class RoutineRepository {
  constructor(private readonly db: DatabaseSync) {}

  public getAllRoutines(): RoutineRecord[] {
    const stmt = this.db.prepare('SELECT * FROM routines ORDER BY id ASC');
    return stmt.all() as unknown as RoutineRecord[];
  }

  public getActiveRoutines(): RoutineRecord[] {
    const stmt = this.db.prepare('SELECT * FROM routines WHERE is_active = 1 ORDER BY id ASC');
    return stmt.all() as unknown as RoutineRecord[];
  }

  public getRoutine(id: string): RoutineRecord | null {
    const stmt = this.db.prepare('SELECT * FROM routines WHERE id = ?');
    const res = stmt.get(id);
    return (res ? (res as unknown as RoutineRecord) : null);
  }

  public setRoutineActive(id: string, isActive: boolean): void {
    const stmt = this.db.prepare('UPDATE routines SET is_active = ? WHERE id = ?');
    stmt.run(isActive ? 1 : 0, id);
  }

  /**
   * Claims a routine for one run. False while another run (any process: server or wake cycle)
   * holds it; a claim older than staleBefore is treated as abandoned (crash) and taken over.
   */
  public claimRun(id: string, nowIso: string, staleBeforeIso: string): boolean {
    const res = this.db.prepare(
      'UPDATE routines SET running_since = ? WHERE id = ? AND (running_since IS NULL OR running_since < ?)'
    ).run(nowIso, id, staleBeforeIso);
    return Number(res.changes) === 1;
  }

  public releaseRun(id: string): void {
    this.db.prepare('UPDATE routines SET running_since = NULL WHERE id = ?').run(id);
  }

  public updateLastRun(id: string, timestamp = new Date().toISOString(), status?: string, traceId?: string, note?: string): void {
    const stmt = this.db.prepare(`
      UPDATE routines
      SET last_run_at = ?,
          last_run_status = COALESCE(?, last_run_status),
          last_run_trace_id = COALESCE(?, last_run_trace_id),
          last_run_note = COALESCE(?, last_run_note)
      WHERE id = ?
    `);
    stmt.run(timestamp, status || null, traceId || null, note || null, id);
  }

  public updateRoutineSchedule(id: string, cronSchedule: string): void {
    const cadenceDesc = formatCronSchedule(cronSchedule);
    const stmt = this.db.prepare(`
      UPDATE routines
      SET cron_schedule = ?, cadence_description = ?
      WHERE id = ?
    `);
    stmt.run(cronSchedule, cadenceDesc, id);
  }

  public updateRoutineInstructions(id: string, description: string): void {
    const stmt = this.db.prepare(`
      UPDATE routines
      SET description = ?
      WHERE id = ?
    `);
    stmt.run(description, id);
  }

  public updateRoutine(id: string, updates: {
    title?: string;
    description?: string;
    cron_schedule?: string;
    destination?: string;
    is_active?: boolean;
    default_grant?: string[];
    hard_constraints?: string[];
    rules?: string[];
    allow_silence?: boolean;
    primary_model?: string;
    evaluator_model?: string;
  }): RoutineRecord | null {
    const existing = this.getRoutine(id);
    if (!existing) return null;

    const title = updates.title !== undefined ? updates.title : existing.title;
    const description = updates.description !== undefined ? updates.description : existing.description;
    const cronSchedule = updates.cron_schedule !== undefined ? updates.cron_schedule : existing.cron_schedule;
    const destination = updates.destination !== undefined ? updates.destination : existing.destination;
    const cadenceDesc = formatCronSchedule(cronSchedule);
    const isActive = updates.is_active !== undefined ? (updates.is_active ? 1 : 0) : existing.is_active;
    const grantJson = updates.default_grant !== undefined
      ? JSON.stringify(updates.default_grant)
      : existing.default_grant;

    const stmt = this.db.prepare(`
      UPDATE routines
      SET title = ?, description = ?, cron_schedule = ?, destination = ?, cadence_description = ?, is_active = ?, default_grant = ?
      WHERE id = ?
    `);
    stmt.run(title, description || null, cronSchedule, destination || null, cadenceDesc, isActive, grantJson || null, id);

    const json = (v?: string[]) => (v === undefined ? undefined : JSON.stringify(v));
    this.db.prepare(`
      UPDATE routines SET
        hard_constraints = COALESCE(?, hard_constraints),
        rules = COALESCE(?, rules),
        allow_silence = COALESCE(?, allow_silence),
        primary_model = COALESCE(?, primary_model),
        evaluator_model = COALESCE(?, evaluator_model)
      WHERE id = ?
    `).run(
      json(updates.hard_constraints) ?? null,
      json(updates.rules) ?? null,
      updates.allow_silence === undefined ? null : (updates.allow_silence ? 1 : 0),
      updates.primary_model ?? null,
      updates.evaluator_model ?? null,
      id
    );

    return this.getRoutine(id);
  }

  public deleteRoutine(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM routines WHERE id = ?');
    const res = stmt.run(id);
    const deleted = res.changes > 0;
    return deleted;
  }

  public upsertRoutine(r: {
    id: string;
    title: string;
    description?: string;
    cron_schedule: string;
    timezone?: string;
    is_active?: number;
    destination?: string;
    cadence_description?: string;
    default_grant?: string[];
    hard_constraints?: string[];
    rules?: string[];
    allow_silence?: boolean;
    primary_model?: string;
    evaluator_model?: string;
  }): void {
    const grantJson = r.default_grant ? JSON.stringify(r.default_grant) : null;
    const cadenceDesc = r.cadence_description || formatCronSchedule(r.cron_schedule);
    const stmt = this.db.prepare(`
      INSERT INTO routines (id, title, description, cron_schedule, timezone, is_active, destination, cadence_description, default_grant, hard_constraints, rules, allow_silence, primary_model, evaluator_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        cron_schedule = excluded.cron_schedule,
        timezone = excluded.timezone,
        is_active = excluded.is_active,
        destination = COALESCE(excluded.destination, routines.destination),
        cadence_description = excluded.cadence_description,
        default_grant = excluded.default_grant,
        hard_constraints = COALESCE(excluded.hard_constraints, routines.hard_constraints),
        rules = COALESCE(excluded.rules, routines.rules),
        allow_silence = COALESCE(excluded.allow_silence, routines.allow_silence),
        primary_model = COALESCE(excluded.primary_model, routines.primary_model),
        evaluator_model = COALESCE(excluded.evaluator_model, routines.evaluator_model)
    `);
    stmt.run(
      r.id,
      r.title,
      r.description || null,
      r.cron_schedule,
      r.timezone || 'Europe/Warsaw',
      r.is_active ?? 1,
      r.destination || null,
      cadenceDesc,
      grantJson,
      r.hard_constraints ? JSON.stringify(r.hard_constraints) : null,
      r.rules ? JSON.stringify(r.rules) : null,
      r.allow_silence === undefined ? null : (r.allow_silence ? 1 : 0),
      r.primary_model || null,
      r.evaluator_model || null
    );
  }



  public getSentinel(id: string): SentinelRecord {
    const stmt = this.db.prepare('SELECT * FROM sentinel_state WHERE id = ?');
    const existing = stmt.get(id) as SentinelRecord | undefined;
    if (existing) return existing;

    // Default to active
    this.db.prepare('INSERT INTO sentinel_state (id, is_active) VALUES (?, 1)').run(id);
    return { id, is_active: 1 };
  }

  public setSentinelActive(id: string, isActive: boolean): void {
    this.db.prepare(`
      INSERT INTO sentinel_state (id, is_active)
      VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET is_active = excluded.is_active
    `).run(id, isActive ? 1 : 0);
  }

  public updateSentinelCheck(id: string, stateJson?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO sentinel_state (id, is_active, last_check_at, state_json)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_check_at = excluded.last_check_at, state_json = excluded.state_json
    `).run(id, now, stateJson || null);
  }

  public listSentinels(): SentinelRecord[] {
    const defaults = ['gmail_sentinel', 'calendar_sentinel', 'proton_sentinel'];
    for (const id of defaults) {
      this.getSentinel(id);
    }
    const stmt = this.db.prepare('SELECT * FROM sentinel_state ORDER BY id ASC');
    return stmt.all() as unknown as SentinelRecord[];
  }

  // --- Sentinel Sender Rules (VIP / Ignore) ---

  public listSenderRules(sentinelId?: string): SentinelSenderRule[] {
    if (sentinelId) {
      const stmt = this.db.prepare('SELECT * FROM sentinel_sender_rules WHERE sentinel_id = ? ORDER BY id ASC');
      return stmt.all(sentinelId) as unknown as SentinelSenderRule[];
    }
    const stmt = this.db.prepare('SELECT * FROM sentinel_sender_rules ORDER BY id ASC');
    return stmt.all() as unknown as SentinelSenderRule[];
  }

  public addSenderRule(sentinelId: string, ruleType: 'vip' | 'ignore', pattern: string, reason?: string): SentinelSenderRule {
    const stmt = this.db.prepare(`
      INSERT INTO sentinel_sender_rules (sentinel_id, rule_type, pattern, reason)
      VALUES (?, ?, ?, ?)
    `);
    const res = stmt.run(sentinelId, ruleType, pattern.trim().toLowerCase(), reason || null);
    const id = Number(res.lastInsertRowid);
    const getStmt = this.db.prepare('SELECT * FROM sentinel_sender_rules WHERE id = ?');
    return getStmt.get(id) as unknown as SentinelSenderRule;
  }

  public removeSenderRule(id: number): boolean {
    const stmt = this.db.prepare('DELETE FROM sentinel_sender_rules WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }
}
