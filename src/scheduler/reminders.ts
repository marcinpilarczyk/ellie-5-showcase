import { DatabaseSync } from 'node:sqlite';
import { SlackClient } from '../integrations/slack/client.js';
import { NudgeGate } from './nudge-gate.js';

export interface ReminderRecord {
  id: string;
  title: string;
  target_time: string;
  status: string;
  channel?: string | null;
  thread_ts?: string | null;
  created_at: string;
}

function canPostSlack(slackClient?: SlackClient): slackClient is SlackClient {
  if (!slackClient) return false;
  if (typeof slackClient.isConfigured === 'function') return slackClient.isConfigured();
  return typeof slackClient.postMessage === 'function';
}

export class ReminderDispatcher {
  constructor(
    private readonly db: DatabaseSync,
    private readonly slackClient?: SlackClient,
    private readonly nudgeGate?: NudgeGate
  ) {}

  public async dispatchDueReminders(now = new Date()): Promise<number> {
    const iso = now.toISOString();
    const stmt = this.db.prepare(`
      SELECT * FROM scheduled_reminders
      WHERE status = 'PENDING' AND target_time <= ?
      ORDER BY target_time ASC
    `);
    const due = stmt.all(iso) as unknown as ReminderRecord[];
    if (due.length === 0) return 0;

    let dispatched = 0;
    for (const r of due) {
      const text = `⏰ *Reminder:* ${r.title}`;
      if (this.nudgeGate) {
        const evalFn = typeof this.nudgeGate.evaluate === 'function'
          ? this.nudgeGate.evaluate.bind(this.nudgeGate)
          : this.nudgeGate.admit.bind(this.nudgeGate);
        const admission = evalFn({
          source: 'reminder',
          priority: 'normal',
          text,
          dedupeKey: `reminder:${r.id}`
        });
        if (admission.decision.action !== 'SEND') {
          continue;
        }
      }

      try {
        if (canPostSlack(this.slackClient)) {
          await this.slackClient.postMessage({
            channel: r.channel || this.slackClient.defaultChannel,
            text,
            thread_ts: r.thread_ts || undefined
          });
        }
        this.db.prepare("UPDATE scheduled_reminders SET status = 'DELIVERED' WHERE id = ?").run(r.id);
        dispatched++;
      } catch (err: any) {
        console.warn(`[ReminderDispatcher] Failed to dispatch reminder ${r.id}:`, err.message);
      }
    }

    return dispatched;
  }

  public addReminder(title: string, targetTime: Date, channel?: string, threadTs?: string): string {
    const id = `rem_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO scheduled_reminders (id, title, target_time, status, channel, thread_ts)
      VALUES (?, ?, ?, 'PENDING', ?, ?)
    `).run(id, title, targetTime.toISOString(), channel || null, threadTs || null);
    return id;
  }

  public listReminders(status?: string): ReminderRecord[] {
    if (status && status !== 'ALL') {
      const stmt = this.db.prepare('SELECT * FROM scheduled_reminders WHERE status = ? ORDER BY target_time ASC');
      return stmt.all(status) as unknown as ReminderRecord[];
    }
    const stmt = this.db.prepare('SELECT * FROM scheduled_reminders ORDER BY target_time ASC');
    return stmt.all() as unknown as ReminderRecord[];
  }

  public getReminder(id: string): ReminderRecord | null {
    const stmt = this.db.prepare('SELECT * FROM scheduled_reminders WHERE id = ?');
    const res = stmt.get(id);
    return (res ? (res as unknown as ReminderRecord) : null);
  }

  public rescheduleReminder(id: string, newTargetTime: Date): boolean {
    const stmt = this.db.prepare(`
      UPDATE scheduled_reminders
      SET target_time = ?, status = 'PENDING'
      WHERE id = ?
    `);
    const res = stmt.run(newTargetTime.toISOString(), id);
    return res.changes > 0;
  }

  public cancelReminder(id: string): boolean {
    const stmt = this.db.prepare("UPDATE scheduled_reminders SET status = 'CANCELLED' WHERE id = ?");
    const res = stmt.run(id);
    return res.changes > 0;
  }

  public deleteReminder(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM scheduled_reminders WHERE id = ?');
    const res = stmt.run(id);
    return res.changes > 0;
  }
}

export { ReminderDispatcher as ReminderScheduler };
