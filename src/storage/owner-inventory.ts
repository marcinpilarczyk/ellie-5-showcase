import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_NAME } from '../config/owner.js';
import { OWNER_TIMEZONE } from '../config/time.js';
import type { OwnerDoc } from '../tools/owner-source-tools.js';

/** Local hour after which the nightly refresh runs (the first wake cycle past it). */
const REFRESH_AFTER_HOUR = 3;
const REFRESHED_ON_KEY = 'owner_inventory_refreshed_on';
const PURPOSE_MAX_CHARS = 200;

export interface InventoryRow {
  doc_id: string;
  title: string;
  folder: string;
  chars: number;
  content_hash: string;
  purpose: string;
  modified_time: string | null;
  updated_at: string;
}

export interface RefreshSummary {
  total: number;
  described: number;
  unchanged: number;
  removed: number;
  failed: number;
}

/** Writes a one-line description of what a Doc is for and what it holds. */
export type DescribeDoc = (title: string, folder: string, text: string) => Promise<string>;

function localDateAndHour(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: OWNER_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/**
 * A nightly map of the owner's working Docs: title, folder and a one-line purpose written by the
 * model from the Doc itself. It sits in the system prompt so a run can pick and read the Docs a
 * task needs in its first step. Docs are still read live; the map only says what exists.
 */
export class OwnerInventory {
  constructor(private readonly db: DatabaseSync) {}

  public list(): InventoryRow[] {
    return this.db.prepare('SELECT * FROM owner_doc_inventory ORDER BY folder, title, doc_id').all() as unknown as InventoryRow[];
  }

  public refreshedOn(): string | undefined {
    const row = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(REFRESHED_ON_KEY) as { value: string } | undefined;
    return row?.value;
  }

  /** Never refreshed, or a new local day past the refresh hour. */
  public isDue(now = new Date()): boolean {
    const last = this.refreshedOn();
    if (!last) return true;
    const { date, hour } = localDateAndHour(now);
    return last !== date && hour >= REFRESH_AFTER_HOUR;
  }

  /** Describes new and changed Docs only (by content hash); drops Docs that are gone. */
  public async refresh(docs: Array<OwnerDoc & { text: string }>, describe: DescribeDoc, now = new Date()): Promise<RefreshSummary> {
    const existing = new Map(this.list().map(r => [r.doc_id, r]));
    const summary: RefreshSummary = { total: docs.length, described: 0, unchanged: 0, removed: 0, failed: 0 };
    const upsert = this.db.prepare(`
      INSERT INTO owner_doc_inventory (doc_id, title, folder, chars, content_hash, purpose, modified_time, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET title = excluded.title, folder = excluded.folder, chars = excluded.chars,
        content_hash = excluded.content_hash, purpose = excluded.purpose, modified_time = excluded.modified_time, updated_at = excluded.updated_at
    `);

    for (const doc of docs) {
      const hash = crypto.createHash('sha256').update(doc.text).digest('hex');
      const prior = existing.get(doc.id);
      const folder = doc.path || '/';
      let purpose = prior?.content_hash === hash ? prior.purpose : undefined;
      if (purpose) {
        summary.unchanged++;
      } else {
        try {
          purpose = (await describe(doc.title, folder, doc.text)).replace(/\s+/g, ' ').trim().slice(0, PURPOSE_MAX_CHARS);
          summary.described++;
        } catch {
          summary.failed++;
        }
        // A failed description keeps the old one, or falls back to the Doc's first line.
        if (!purpose) purpose = prior?.purpose || doc.text.split('\n').find(l => l.trim())?.trim().slice(0, PURPOSE_MAX_CHARS) || '(empty)';
      }
      upsert.run(doc.id, doc.title, folder, doc.text.length, hash, purpose, doc.modifiedTime ?? null, now.toISOString());
    }

    const seen = new Set(docs.map(d => d.id));
    for (const id of existing.keys()) {
      if (seen.has(id)) continue;
      this.db.prepare('DELETE FROM owner_doc_inventory WHERE doc_id = ?').run(id);
      summary.removed++;
    }

    this.db.prepare(`
      INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(REFRESHED_ON_KEY, localDateAndHour(now).date);
    return summary;
  }

  /** The prompt block; empty when there is no inventory yet (runs then list Docs live). */
  public promptBlock(): string {
    const rows = this.list();
    if (rows.length === 0) return '';
    const lines = rows.map(r => `- ${r.title} (${r.folder}, ${r.chars} chars): ${r.purpose}`);
    return `${OWNER_NAME.toUpperCase()}'S WORKING DOCS (inventory refreshed ${this.refreshedOn() ?? 'recently'}; read the ones a task needs with owner_sources_read docs=[titles], in your first step, alongside other reads):\n${lines.join('\n')}`;
  }
}
