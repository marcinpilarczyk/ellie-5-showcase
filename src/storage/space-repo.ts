import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type SpaceCategory = 'report' | 'dashboard' | 'radar' | 'tracker' | 'memo' | string;
export type SpaceStatus = 'active' | 'archived';

export interface SpaceRecord {
  slug: string;
  title: string;
  description?: string | null;
  category: SpaceCategory;
  created_by: string;
  trigger_type?: string | null;
  run_id?: string | null;
  status: SpaceStatus;
  created_at: string;
  updated_at: string;
}

export interface UpsertSpaceInput {
  slug: string;
  title: string;
  description?: string | null;
  category?: SpaceCategory;
  created_by?: string;
  trigger_type?: string | null;
  run_id?: string | null;
  status?: SpaceStatus;
  htmlContent?: string;
}

export interface ListSpacesFilter {
  status?: SpaceStatus | 'all';
  category?: string;
  search?: string;
  limit?: number;
}

export class SpaceRepository {
  private readonly spacesDir: string;

  constructor(
    private readonly db: DatabaseSync,
    spacesBaseDir?: string
  ) {
    const dataDir = process.env.ELLIE_DATA_DIR || 'data';
    this.spacesDir = spacesBaseDir || path.resolve(dataDir, 'spaces');
    if (!fs.existsSync(this.spacesDir)) {
      try {
        fs.mkdirSync(this.spacesDir, { recursive: true });
      } catch {
        // Ignored if exists or read-only in mock tests
      }
    }
  }

  public getSpacesDir(): string {
    return this.spacesDir;
  }

  public getSpaceFilePath(slug: string): string {
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    return path.join(this.spacesDir, cleanSlug, 'index.html');
  }

  public saveContent(slug: string, html: string): void {
    const filePath = this.getSpaceFilePath(slug);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, html, 'utf8');
  }

  public getContent(slug: string): string | null {
    const filePath = this.getSpaceFilePath(slug);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return null;
  }

  public upsert(input: UpsertSpaceInput): SpaceRecord {
    const cleanSlug = input.slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (!cleanSlug) throw new Error('Invalid slug for space');

    const now = new Date().toISOString();
    const existing = this.get(cleanSlug);

    const category = input.category || existing?.category || 'report';
    const createdBy = input.created_by || existing?.created_by || 'ellie';
    const triggerType = input.trigger_type || existing?.trigger_type || 'routine';
    const runId = input.run_id ?? existing?.run_id ?? null;
    const status = input.status || existing?.status || 'active';
    const description = input.description ?? existing?.description ?? null;
    const title = input.title.trim();

    if (existing) {
      this.db.prepare(`
        UPDATE spaces
        SET title = ?, description = ?, category = ?, trigger_type = ?, run_id = ?, status = ?, updated_at = ?
        WHERE slug = ?
      `).run(title, description, category, triggerType, runId, status, now, cleanSlug);
    } else {
      this.db.prepare(`
        INSERT INTO spaces (
          slug, title, description, category, created_by, trigger_type, run_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cleanSlug, title, description, category, createdBy, triggerType, runId, status, now, now);
    }

    if (input.htmlContent !== undefined) {
      this.saveContent(cleanSlug, input.htmlContent);
    }

    return this.get(cleanSlug)!;
  }

  public get(slug: string): SpaceRecord | null {
    const cleanSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    const stmt = this.db.prepare('SELECT * FROM spaces WHERE slug = ?');
    const row = stmt.get(cleanSlug);
    return row ? (row as unknown as SpaceRecord) : null;
  }

  public list(filter: ListSpacesFilter = { status: 'all' }): SpaceRecord[] {
    const conditions: string[] = [];
    const params: any[] = [];

    const status = filter.status ?? 'all';
    if (status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }

    if (filter.category) {
      conditions.push('category = ?');
      params.push(filter.category);
    }

    if (filter.search) {
      conditions.push('(LOWER(title) LIKE ? OR LOWER(slug) LIKE ? OR LOWER(description) LIKE ?)');
      const q = `%${filter.search.trim().toLowerCase()}%`;
      params.push(q, q, q);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = filter.limit && filter.limit > 0 ? `LIMIT ${Number(filter.limit)}` : '';
    const sql = `SELECT * FROM spaces ${where} ORDER BY updated_at DESC ${limitClause}`;

    return this.db.prepare(sql).all(...params) as unknown as SpaceRecord[];
  }

  public archive(slug: string): SpaceRecord | null {
    const existing = this.get(slug);
    if (!existing) return null;

    const now = new Date().toISOString();
    this.db.prepare('UPDATE spaces SET status = ?, updated_at = ? WHERE slug = ?').run('archived', now, existing.slug);
    return this.get(existing.slug);
  }

  public delete(slug: string): boolean {
    const existing = this.get(slug);
    if (!existing) return false;

    this.db.prepare('DELETE FROM spaces WHERE slug = ?').run(existing.slug);
    const filePath = this.getSpaceFilePath(existing.slug);
    const dir = path.dirname(filePath);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignored
      }
    }
    return true;
  }
}
