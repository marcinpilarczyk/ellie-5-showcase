import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export type WaitingStatus = 'open' | 'nudged' | 'resolved';

export interface WaitingItem {
  id: string;
  counterparty: string;
  subject: string;
  channel: string;
  thread_ref?: string | null;
  due_at?: string | null;
  status: WaitingStatus;
  created_at: string;
  updated_at: string;
}

export interface TrackWaitingInput {
  id?: string;
  counterparty: string;
  subject: string;
  channel?: string;
  thread_ref?: string | null;
  due_at?: string | null;
  status?: WaitingStatus;
}

export interface ListWaitingFilter {
  status?: WaitingStatus | 'active' | 'all';
  dueBefore?: string;
  counterparty?: string;
}

export class WaitingRepository {
  constructor(private readonly db: DatabaseSync) {}

  public track(input: TrackWaitingInput): WaitingItem {
    const id = input.id || `wait_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const status: WaitingStatus = input.status || 'open';
    const channel = input.channel || 'email';

    const stmt = this.db.prepare(`
      INSERT INTO waiting_items (
        id, counterparty, subject, channel, thread_ref, due_at, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.counterparty.trim(),
      input.subject.trim(),
      channel.trim(),
      input.thread_ref?.trim() || null,
      input.due_at?.trim() || null,
      status,
      now,
      now
    );

    return this.get(id)!;
  }

  public get(id: string): WaitingItem | null {
    const stmt = this.db.prepare('SELECT * FROM waiting_items WHERE id = ?');
    const row = stmt.get(id);
    return row ? (row as unknown as WaitingItem) : null;
  }

  public list(filter: ListWaitingFilter = { status: 'active' }): WaitingItem[] {
    const conditions: string[] = [];
    const params: any[] = [];

    const statusFilter = filter.status ?? 'active';
    if (statusFilter === 'active') {
      conditions.push("status IN ('open', 'nudged')");
    } else if (statusFilter !== 'all') {
      conditions.push('status = ?');
      params.push(statusFilter);
    }

    if (filter.dueBefore) {
      conditions.push('due_at IS NOT NULL AND due_at <= ?');
      params.push(filter.dueBefore);
    }

    if (filter.counterparty) {
      conditions.push('LOWER(counterparty) LIKE ?');
      params.push(`%${filter.counterparty.trim().toLowerCase()}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM waiting_items ${where} ORDER BY due_at ASC NULLS LAST, created_at DESC`;
    return this.db.prepare(sql).all(...params) as unknown as WaitingItem[];
  }

  public resolve(id: string, notes?: string): WaitingItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const subject = notes ? `${existing.subject} [resolved: ${notes.trim()}]` : existing.subject;
    const stmt = this.db.prepare(`
      UPDATE waiting_items
      SET status = 'resolved', subject = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(subject, now, id);
    return this.get(id);
  }

  public nudge(id: string): WaitingItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE waiting_items
      SET status = 'nudged', updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, id);
    return this.get(id);
  }

  public delete(id: string): boolean {
    const res = this.db.prepare('DELETE FROM waiting_items WHERE id = ?').run(id);
    return (res as any)?.changes > 0;
  }
}
