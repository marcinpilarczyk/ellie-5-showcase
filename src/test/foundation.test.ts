import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_MIGRATIONS, initializeAppDatabase, migrate } from '../storage/schema.js';
import { exportGoogleToken, importGoogleToken } from '../scripts/google-token.js';

describe('Foundation (lessons from v2/v4)', () => {
  it('applies migrations once and records them', () => {
    const db = new DatabaseSync(':memory:');
    assert.deepEqual(migrate(db, APP_MIGRATIONS, 'app'), APP_MIGRATIONS.map(m => m.version));
    assert.deepEqual(migrate(db, APP_MIGRATIONS, 'app'), [], 'second run is a no-op');
    const row = db.prepare('SELECT version, name FROM schema_migrations').get() as any;
    assert.equal(row.version, 1);
  });

  it("refuses to run on another version's database", () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE routines (id TEXT PRIMARY KEY, legacy_column TEXT)');
    assert.throws(() => initializeAppDatabase(db), /did not create/);
  });

  it('moves the Google connection between databases without losing the refresh token', () => {
    const dir = path.resolve('.test-data', 'token-move');
    fs.mkdirSync(dir, { recursive: true });
    const oldPath = path.join(dir, 'old.sqlite');
    fs.rmSync(oldPath, { force: true });

    const old = new DatabaseSync(oldPath);
    old.exec(`CREATE TABLE integrations (id TEXT PRIMARY KEY, provider TEXT, account_email TEXT, access_token TEXT,
      refresh_token TEXT, token_expires_at TEXT, scopes TEXT, updated_at TEXT)`);
    old.prepare(`INSERT INTO integrations VALUES ('google_main', 'google', 'owner@example.com', 'at', 'rt-123', NULL, NULL, '2026-10-01')`).run();
    old.close();

    const token = exportGoogleToken(oldPath);
    assert.equal(token.refresh_token, 'rt-123');

    const fresh = new DatabaseSync(':memory:');
    initializeAppDatabase(fresh);
    importGoogleToken(fresh, token);
    const row = fresh.prepare("SELECT status, refresh_token, account_email FROM integrations WHERE id = 'google_main'").get() as any;
    assert.equal(row.status, 'connected');
    assert.equal(row.refresh_token, 'rt-123');
    assert.equal(row.account_email, 'owner@example.com');
  });

  it('rejects a Google OAuth callback that Ellie did not start', async () => {
    const { createApp } = await import('../http/app.js');
    const { buildRuntime } = await import('../runtime/build-runtime.js');
    const runtime = buildRuntime({ appDbPath: ':memory:', ledgerDbPath: ':memory:' });
    const app = createApp(runtime);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try {
      const port = (server.address() as any).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/integrations/google/callback?code=attacker-code&state=forged`);
      assert.equal(res.status, 400);
      const connect = await fetch(`http://127.0.0.1:${port}/api/integrations/google/connect`, { redirect: 'manual' });
      assert.equal(connect.status, 401, 'starting a Google connection requires the control-page login');
    } finally {
      server.close();
      runtime.dbManager.close();
    }
  });

  it('Migration 11 initializes rrsi_edit_ledger table and indexes', () => {
    const db = new DatabaseSync(':memory:');
    initializeAppDatabase(db);

    // Verify rrsi_edit_ledger table existence and schema
    const tableInfo = db.prepare("PRAGMA table_info(rrsi_edit_ledger)").all() as Array<{ name: string; type: string }>;
    const columnNames = tableInfo.map(c => c.name);
    const expectedColumns = [
      'id', 'component_type', 'target_id', 'hypothesis', 'diff_text',
      'delta_score', 'delta_cost', 'accepted', 'status', 'trials',
      'positive_trials', 'negative_trials', 'created_at', 'updated_at'
    ];
    for (const col of expectedColumns) {
      assert.ok(columnNames.includes(col), `Missing expected column: ${col}`);
    }

    // Verify indexes
    const indexInfo = db.prepare("PRAGMA index_list(rrsi_edit_ledger)").all() as Array<{ name: string }>;
    const indexNames = indexInfo.map(i => i.name);
    assert.ok(indexNames.includes('idx_rrsi_component_status'), 'Missing idx_rrsi_component_status');
    assert.ok(indexNames.includes('idx_rrsi_target'), 'Missing idx_rrsi_target');

    // Verify insert and query functionality
    db.prepare(`
      INSERT INTO rrsi_edit_ledger (
        id, component_type, target_id, hypothesis, diff_text,
        delta_score, delta_cost, accepted, status, trials,
        positive_trials, negative_trials, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rrsi-test-1',
      'preference',
      'cand-1',
      'Avoid bullet bloat in emails',
      '- Always use paragraphs instead of bullets for 1-sentence notes',
      1.0,
      12,
      1,
      'accepted',
      3,
      3,
      0,
      new Date().toISOString(),
      new Date().toISOString()
    );

    const record = db.prepare("SELECT * FROM rrsi_edit_ledger WHERE id = ?").get('rrsi-test-1') as any;
    assert.equal(record.id, 'rrsi-test-1');
    assert.equal(record.component_type, 'preference');
    assert.equal(record.status, 'accepted');
    assert.equal(record.accepted, 1);
    assert.equal(record.delta_score, 1.0);
  });
});
