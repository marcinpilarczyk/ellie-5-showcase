import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export type NudgePriority = 'urgent' | 'high' | 'normal' | 'digest';
export type NudgeAction = 'SEND' | 'HOLD' | 'DROP';

export interface NudgeDecision {
  action: NudgeAction;
  reason?: string;
}

export interface NudgePolicyConfig {
  quietHoursStart: number; // e.g. 21 (9 PM)
  quietHoursEnd: number;   // e.g. 8  (8 AM)
  dailyCap: number;        // e.g. 8
  timezone: string;        // 'Europe/Warsaw'
}

export const DEFAULT_NUDGE_CONFIG: NudgePolicyConfig = {
  quietHoursStart: 21,
  quietHoursEnd: 8,
  dailyCap: 8,
  timezone: 'Europe/Warsaw'
};

export function isQuietTime(now: Date, config: NudgePolicyConfig): boolean {
  const hour = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: 'numeric', hourCycle: 'h23' }).format(now),
    10
  );
  if (config.quietHoursStart > config.quietHoursEnd) {
    return hour >= config.quietHoursStart || hour < config.quietHoursEnd;
  }
  return hour >= config.quietHoursStart && hour < config.quietHoursEnd;
}

export function decideNudge(opts: {
  priority: NudgePriority;
  now: Date;
  sentToday: number;
  isDuplicate: boolean;
  config: NudgePolicyConfig;
  snoozedUntil?: Date | null;
}): NudgeDecision {
  if (opts.isDuplicate) {
    return { action: 'DROP', reason: 'Duplicate nudge within 24h window' };
  }
  if (opts.priority === 'urgent' || opts.priority === 'high') {
    return { action: 'SEND' };
  }
  if (opts.snoozedUntil && opts.now < opts.snoozedUntil) {
    return { action: 'HOLD', reason: `Proactive messages snoozed until ${opts.snoozedUntil.toISOString()}` };
  }
  if (isQuietTime(opts.now, opts.config)) {
    return { action: 'HOLD', reason: 'Quiet hours in Europe/Warsaw' };
  }
  if (opts.sentToday >= opts.config.dailyCap) {
    return { action: 'HOLD', reason: `Daily proactive message cap (${opts.config.dailyCap}) reached` };
  }
  return { action: 'SEND' };
}

export interface NudgeRequest {
  source: string;
  priority: NudgePriority;
  text: string;
  dedupeKey?: string;
}

export interface NudgeAdmission {
  id: string;
  decision: NudgeDecision;
}

export class NudgeGate {
  constructor(
    private readonly appDb: DatabaseSync,
    private readonly config: NudgePolicyConfig = DEFAULT_NUDGE_CONFIG,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private getEffectiveConfig(): { config: NudgePolicyConfig; snoozedUntil: Date | null } {
    let start = this.config.quietHoursStart;
    let end = this.config.quietHoursEnd;
    let cap = this.config.dailyCap;
    let snoozedUntil: Date | null = null;

    try {
      const rows = this.appDb.prepare('SELECT key, value FROM system_settings').all() as Array<{ key: string; value: string }>;
      for (const row of rows) {
        if (row.key === 'quiet_hours_start') start = parseInt(row.value, 10);
        if (row.key === 'quiet_hours_end') end = parseInt(row.value, 10);
        if (row.key === 'daily_nudge_cap') cap = parseInt(row.value, 10);
        if (row.key === 'snooze_until' && row.value) {
          const dt = new Date(row.value);
          if (!isNaN(dt.getTime())) snoozedUntil = dt;
        }
      }
    } catch {}

    return {
      config: {
        quietHoursStart: start,
        quietHoursEnd: end,
        dailyCap: cap,
        timezone: this.config.timezone
      },
      snoozedUntil
    };
  }

  public getSettings(): {
    quietHoursStart: number;
    quietHoursEnd: number;
    dailyCap: number;
    snoozeUntil: string | null;
    isSnoozed: boolean;
  } {
    const { config, snoozedUntil } = this.getEffectiveConfig();
    const now = this.clock();
    const isSnoozed = Boolean(snoozedUntil && now < snoozedUntil);
    return {
      quietHoursStart: config.quietHoursStart,
      quietHoursEnd: config.quietHoursEnd,
      dailyCap: config.dailyCap,
      snoozeUntil: snoozedUntil ? snoozedUntil.toISOString() : null,
      isSnoozed
    };
  }

  public snooze(until: Date): void {
    this.appDb.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('snooze_until', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(until.toISOString());
  }

  public unsnooze(): void {
    this.appDb.prepare(`DELETE FROM system_settings WHERE key = 'snooze_until'`).run();
  }

  public setQuietHours(startHour: number, endHour: number): void {
    const stmt = this.appDb.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run('quiet_hours_start', String(startHour));
    stmt.run('quiet_hours_end', String(endHour));
  }

  public setDailyCap(cap: number): void {
    this.appDb.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('daily_nudge_cap', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(cap));
  }

  public evaluate(request: NudgeRequest): NudgeAdmission {
    return this.admit(request);
  }

  public admit(request: NudgeRequest): NudgeAdmission {
    const now = this.clock();
    const { config, snoozedUntil } = this.getEffectiveConfig();
    const dateKey = now.toLocaleDateString('en-CA', { timeZone: config.timezone });

    let sentToday = 0;
    try {
      const row = this.appDb.prepare(
        `SELECT COUNT(*) AS n FROM nudge_log WHERE status = 'SENT' AND local_date = ?`
      ).get(dateKey) as { n: number } | undefined;
      sentToday = Number(row?.n || 0);
    } catch {}

    let isDuplicate = false;
    let existingHeld: { id: string } | undefined;
    if (request.dedupeKey) {
      const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const sentRow = this.appDb.prepare(
        `SELECT 1 FROM nudge_log WHERE dedupe_key = ? AND status = 'SENT' AND created_at >= ? LIMIT 1`
      ).get(request.dedupeKey, since);
      isDuplicate = Boolean(sentRow);

      if (!isDuplicate) {
        existingHeld = this.appDb.prepare(
          `SELECT id FROM nudge_log WHERE dedupe_key = ? AND status = 'HELD' AND created_at >= ? LIMIT 1`
        ).get(request.dedupeKey, since) as { id: string } | undefined;
      }
    }

    const decision = decideNudge({
      priority: request.priority,
      now,
      sentToday,
      isDuplicate,
      config,
      snoozedUntil
    });

    if (existingHeld) {
      if (decision.action === 'SEND') {
        try {
          this.appDb.prepare(
            `UPDATE nudge_log SET status = 'SENT', reason = NULL, local_date = ?, created_at = ? WHERE id = ?`
          ).run(dateKey, now.toISOString(), existingHeld.id);
        } catch {}
        return { id: existingHeld.id, decision };
      }
      if (decision.action === 'HOLD') {
        return { id: existingHeld.id, decision };
      }
    }

    const id = `nudge_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const status = decision.action === 'SEND' ? 'SENT' : decision.action === 'HOLD' ? 'HELD' : 'DROPPED';

    try {
      this.appDb.prepare(`
        INSERT INTO nudge_log (id, source, priority, dedupe_key, text, status, reason, local_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        request.source,
        request.priority,
        request.dedupeKey || null,
        request.text,
        status,
        decision.reason || null,
        dateKey,
        now.toISOString()
      );
    } catch {}

    return { id, decision };
  }

  public prepareDigest(): { text: string; ids: string[] } | null {
    const now = this.clock();
    const { config, snoozedUntil } = this.getEffectiveConfig();
    if (snoozedUntil && now < snoozedUntil) return null;
    if (isQuietTime(now, config)) return null;

    const dateKey = now.toLocaleDateString('en-CA', { timeZone: config.timezone });
    const row = this.appDb.prepare(
      `SELECT COUNT(*) AS n FROM nudge_log WHERE status = 'SENT' AND local_date = ?`
    ).get(dateKey) as { n: number } | undefined;
    if (Number(row?.n || 0) >= config.dailyCap) return null;

    const held = this.appDb.prepare(
      `SELECT id, text FROM nudge_log WHERE status = 'HELD' ORDER BY created_at ASC LIMIT 10`
    ).all() as Array<{ id: string; text: string }>;
    if (held.length === 0) return null;

    const lines = held.map(h => `• ${h.text.split('\n')[0].slice(0, 200)}`);
    const text = `Held updates while you were away (${held.length}):\n${lines.join('\n')}`;
    return { text, ids: held.map(h => h.id) };
  }

  public completeDigest(ids: string[]): void {
    const update = this.appDb.prepare(`UPDATE nudge_log SET status = 'DIGESTED' WHERE id = ?`);
    for (const id of ids) update.run(id);
  }

  public deliverHeldMessagesNow(): { deliveredCount: number; messages: string[] } {
    const held = this.appDb.prepare(
      `SELECT id, text FROM nudge_log WHERE status = 'HELD' ORDER BY created_at ASC`
    ).all() as Array<{ id: string; text: string }>;

    if (held.length === 0) {
      return { deliveredCount: 0, messages: [] };
    }

    const ids = held.map(h => h.id);
    const update = this.appDb.prepare(`UPDATE nudge_log SET status = 'SENT' WHERE id = ?`);
    for (const id of ids) update.run(id);

    return {
      deliveredCount: held.length,
      messages: held.map(h => h.text)
    };
  }
}
