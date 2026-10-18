import { DatabaseSync } from 'node:sqlite';

export interface WorkspaceAliasRecord {
  alias_key: string;
  name: string;
  resource_type: 'sheet' | 'doc' | 'drive_folder';
  resource_id: string;
  url?: string | null;
  updated_at: string;
}

export function parseGoogleResource(input: string): {
  id: string;
  type: 'sheet' | 'doc' | 'drive_folder';
  cleanUrl?: string;
} {
  const trimmed = input.trim();

  // Spreadsheets
  const sheetMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheetMatch) {
    return { id: sheetMatch[1], type: 'sheet', cleanUrl: trimmed };
  }

  // Documents
  const docMatch = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) {
    return { id: docMatch[1], type: 'doc', cleanUrl: trimmed };
  }

  // Drive Folders
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) {
    return { id: folderMatch[1], type: 'drive_folder', cleanUrl: trimmed };
  }

  // Fallback to raw ID or path
  return { id: trimmed, type: 'sheet' };
}

export class WorkspaceAliasRepository {
  constructor(private readonly db: DatabaseSync) {}

  public listAliases(): WorkspaceAliasRecord[] {
    const stmt = this.db.prepare('SELECT * FROM workspace_aliases ORDER BY alias_key ASC');
    return stmt.all() as unknown as WorkspaceAliasRecord[];
  }

  public getAlias(key: string): WorkspaceAliasRecord | null {
    const normKey = key.trim().toLowerCase();
    const stmt = this.db.prepare('SELECT * FROM workspace_aliases WHERE alias_key = ?');
    const res = stmt.get(normKey);
    return (res ? (res as unknown as WorkspaceAliasRecord) : null);
  }

  public setAlias(
    key: string,
    resourceIdOrUrl: string,
    name?: string,
    resourceType?: 'sheet' | 'doc' | 'drive_folder'
  ): WorkspaceAliasRecord {
    const normKey = key.trim().toLowerCase();
    const parsed = parseGoogleResource(resourceIdOrUrl);
    const finalId = parsed.id;
    const finalType = resourceType || parsed.type;
    const defaultName = name || this.defaultAliasName(normKey) || normKey;
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO workspace_aliases (alias_key, name, resource_type, resource_id, url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_key) DO UPDATE SET
        name = excluded.name,
        resource_type = excluded.resource_type,
        resource_id = excluded.resource_id,
        url = excluded.url,
        updated_at = excluded.updated_at
    `);
    stmt.run(normKey, defaultName, finalType, finalId, parsed.cleanUrl || null, now);

    return this.getAlias(normKey)!;
  }

  public deleteAlias(key: string): boolean {
    const normKey = key.trim().toLowerCase();
    const stmt = this.db.prepare('DELETE FROM workspace_aliases WHERE alias_key = ?');
    const res = stmt.run(normKey);
    return res.changes > 0;
  }

  public resolveId(keyOrIdOrUrl: string): string {
    const trimmed = keyOrIdOrUrl.trim();
    const alias = this.getAlias(trimmed);
    if (alias) return alias.resource_id;

    const parsed = parseGoogleResource(trimmed);
    return parsed.id;
  }

  public seedFromEnv(): void {
    const seeds: Array<{ key: string; name: string; type: 'sheet' | 'doc' | 'drive_folder'; envVal?: string; fallback?: string }> = [
      {
        key: 'job_tracker',
        name: 'Job Tracker',
        type: 'sheet',
        envVal: process.env.ELLIE_TARGET_TRACKER_ID,
        fallback: '1uQxkdyDA-ZhxVhOG8RxBw14SKOd0c5FDfxg_HzUqCK4'
      },
      {
        key: 'advisory_tracker',
        name: 'Advisory Tracker',
        type: 'sheet',
        envVal: process.env.ELLIE_PROSPECT_TRACKER_ID,
        fallback: '13g5AvHlk9ayDm1tLKggk91WYJYttbrGJtVfrmS9Wl7k'
      },
      {
        key: 'claims_bank_doc',
        name: 'Claims Bank Doc',
        type: 'doc',
        envVal: process.env.ELLIE_CLAIMS_BANK_DOC_ID
      },
      {
        key: 'config_doc',
        name: 'Config Doc',
        type: 'doc',
        envVal: process.env.ELLIE_OWNER_CONFIG_DOC_ID
      },
      {
        key: 'professional_record_doc',
        name: 'Professional Record Doc',
        type: 'doc',
        envVal: process.env.ELLIE_PROFESSIONAL_RECORD_DOC_ID
      }
    ];

    for (const seed of seeds) {
      const val = seed.envVal?.trim() || seed.fallback;
      if (!val) continue;

      // Only seed if not already present in SQLite (so SQLite overrides thereafter!)
      const existing = this.getAlias(seed.key);
      if (!existing) {
        this.setAlias(seed.key, val, seed.name, seed.type);
      }
    }
  }

  private defaultAliasName(key: string): string {
    const map: Record<string, string> = {
      job_tracker: 'Job Tracker',
      advisory_tracker: 'Advisory Tracker',
      claims_bank_doc: 'Claims Bank Doc',
      config_doc: 'Config Doc',
      professional_record_doc: 'Professional Record Doc'
    };
    return map[key] || key;
  }
}
