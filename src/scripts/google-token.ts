import 'dotenv/config';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseManager } from '../storage/database.js';
import { initializeAppDatabase } from '../storage/schema.js';

/**
 * Moves the Google OAuth connection between installs without printing any token.
 *
 *   google-token export --from <old app.sqlite> --out <token.json>
 *   google-token import --from <token.json>          (into this install's ELLIE_DATA_DIR)
 */

export interface GoogleTokenFile {
  account_email: string | null;
  access_token: string | null;
  refresh_token: string;
  token_expires_at: string | null;
  scopes: string | null;
  exported_at: string;
  source: string;
}

export function exportGoogleToken(fromDbPath: string): GoogleTokenFile {
  if (!fs.existsSync(fromDbPath)) throw new Error(`No database at ${fromDbPath}`);
  const db = new DatabaseSync(fromDbPath, { readOnly: true });
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'integrations'").get();
    if (!hasTable) throw new Error(`${fromDbPath} has no integrations table`);
    const row = (db.prepare("SELECT * FROM integrations WHERE id = 'google_main'").get()
      ?? db.prepare("SELECT * FROM integrations WHERE provider = 'google' AND refresh_token IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get()) as any;
    if (!row?.refresh_token) throw new Error('No Google connection with a refresh token found');
    return {
      account_email: row.account_email ?? null,
      access_token: row.access_token ?? null,
      refresh_token: row.refresh_token,
      token_expires_at: row.token_expires_at ?? null,
      scopes: row.scopes ?? null,
      exported_at: new Date().toISOString(),
      source: fromDbPath
    };
  } finally {
    db.close();
  }
}

export function importGoogleToken(db: DatabaseSync, token: GoogleTokenFile): void {
  if (!token?.refresh_token) throw new Error('Token file has no refresh_token');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO integrations (id, provider, status, account_email, access_token, refresh_token, token_expires_at, scopes, updated_at)
    VALUES ('google_main', 'google', 'connected', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'connected', account_email = excluded.account_email, access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at,
      scopes = excluded.scopes, updated_at = excluded.updated_at
  `).run(token.account_email, token.access_token, token.refresh_token, token.token_expires_at, token.scopes, now);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const mode = process.argv[2];
  const from = arg('from');
  if (mode === 'export') {
    const out = arg('out');
    if (!from || !out) throw new Error('Usage: google-token export --from <old app.sqlite> --out <token.json>');
    const token = exportGoogleToken(from);
    fs.writeFileSync(out, JSON.stringify(token, null, 2), { mode: 0o600 });
    console.log(`Exported Google connection for ${token.account_email ?? 'unknown account'} to ${out} (mode 600).`);
  } else if (mode === 'import') {
    if (!from) throw new Error('Usage: google-token import --from <token.json>');
    const token = JSON.parse(fs.readFileSync(from, 'utf8')) as GoogleTokenFile;
    const manager = new DatabaseManager();
    const db = manager.getAppDb();
    initializeAppDatabase(db);
    importGoogleToken(db, token);
    manager.close();
    console.log(`Imported Google connection for ${token.account_email ?? 'unknown account'} into ${manager.appDbPath}.`);
  } else {
    throw new Error('Usage: google-token export|import ...');
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/google-token.js')) {
  try {
    main();
  } catch (err: any) {
    console.error(`google-token: ${err.message}`);
    process.exit(1);
  }
}
