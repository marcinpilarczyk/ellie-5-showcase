import { DatabaseSync } from 'node:sqlite';

/**
 * Versioned migrations. Each entry runs once, in order, inside a transaction, and is recorded
 * in schema_migrations. Never edit a shipped migration: add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const APP_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      -- Large tool results kept out of the prompt (handles + previews)
      CREATE TABLE tool_results (
        handle TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        content TEXT NOT NULL,
        preview TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_tool_results_run ON tool_results(run_id);

      -- One trace per run
      CREATE TABLE run_traces (
        run_id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        instruction TEXT,
        status TEXT NOT NULL,
        delivery_mode TEXT NOT NULL,
        tools_called TEXT,
        handles_used TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        thinking_tokens INTEGER DEFAULT 0,
        candidates_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_run_traces_created ON run_traces(created_at);

      -- OAuth connections
      CREATE TABLE integrations (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'not_configured',
        account_email TEXT,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at DATETIME,
        scopes TEXT,
        last_verified DATETIME,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE memory_facts (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL DEFAULT 'general',
        category TEXT NOT NULL DEFAULT 'FACT',
        statement TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        source TEXT DEFAULT 'owner',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_memory_domain ON memory_facts(domain);

      -- Graduated learning: candidate -> promoted
      CREATE TABLE preference_candidates (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL DEFAULT 'global',
        key TEXT NOT NULL,
        preferred_value TEXT NOT NULL,
        occurrences INTEGER DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_pref_candidates_key ON preference_candidates(key);

      -- Routines live in the database only (created and edited from Slack)
      CREATE TABLE routines (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        cron_schedule TEXT NOT NULL,
        timezone TEXT DEFAULT 'Europe/Warsaw',
        is_active INTEGER DEFAULT 1,
        destination TEXT,
        cadence_description TEXT,
        default_grant TEXT,
        hard_constraints TEXT,
        rules TEXT,
        allow_silence INTEGER DEFAULT 0,
        primary_model TEXT,
        last_run_at DATETIME,
        last_run_status TEXT,
        last_run_trace_id TEXT,
        last_run_note TEXT,
        next_run_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Evidence from the last run in a Slack thread
      CREATE TABLE thread_carryover (
        thread_key TEXT PRIMARY KEY,
        run_id TEXT,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sentinel_state (
        id TEXT PRIMARY KEY,
        is_active INTEGER DEFAULT 1,
        last_check_at DATETIME,
        state_json TEXT
      );

      CREATE TABLE sentinel_sender_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sentinel_id TEXT NOT NULL,
        rule_type TEXT NOT NULL,
        pattern TEXT NOT NULL,
        reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_sender_rules_sentinel ON sentinel_sender_rules(sentinel_id);

      -- Snooze, quiet hours, daily cap overrides
      CREATE TABLE system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Named Doc / Sheet / folder IDs ("the prospect tracker")
      CREATE TABLE workspace_aliases (
        alias_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        url TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        thinking_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_api_usage_created ON api_usage(created_at);

      CREATE TABLE scheduled_reminders (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        target_time DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        channel TEXT,
        thread_ts TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_reminders_target ON scheduled_reminders(target_time);

      -- Owner config Docs cached locally
      CREATE TABLE owner_config_cache (
        doc_id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        loaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE nudge_log (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        dedupe_key TEXT,
        text TEXT,
        status TEXT DEFAULT 'SENT',
        reason TEXT,
        local_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_nudge_dedupe ON nudge_log(dedupe_key);
    `
  },
  {
    version: 2,
    name: 'run_traces: wall-clock duration_ms, model time in model_ms',
    sql: `
      -- Until now duration_ms held summed model time; keep that value as model_ms
      ALTER TABLE run_traces ADD COLUMN model_ms INTEGER DEFAULT 0;
      UPDATE run_traces SET model_ms = duration_ms;
    `
  },
  {
    version: 3,
    name: 'owner_doc_inventory: nightly map of the owner working Docs',
    sql: `
      CREATE TABLE owner_doc_inventory (
        doc_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        folder TEXT NOT NULL,
        chars INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        purpose TEXT NOT NULL,
        modified_time TEXT,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 4,
    name: 'thread_carryover: entries kept across all runs in a thread',
    sql: `
      ALTER TABLE thread_carryover ADD COLUMN entries_json TEXT;
    `
  },
  {
    version: 5,
    name: 'evidence: resources Ellie wrote and stored results that are not sources',
    sql: `
      CREATE TABLE authored_resources (
        resource_id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      ALTER TABLE tool_results ADD COLUMN not_evidence INTEGER NOT NULL DEFAULT 0;
      -- Docs written before this migration, from the run traces
      INSERT OR IGNORE INTO authored_resources (resource_id, tool_name, run_id, created_at)
        SELECT json_extract(c.value, '$.result.documentId'), 'docs_create', r.run_id, r.created_at
        FROM run_traces r, json_each(r.tools_called) c
        WHERE json_valid(r.tools_called)
          AND json_extract(c.value, '$.tool') = 'docs_create'
          AND json_extract(c.value, '$.result.documentId') IS NOT NULL;
      -- Stored results that already repeat Ellie's own text
      UPDATE tool_results SET not_evidence = 1
        WHERE tool_name IN ('owner_text_check', 'trace_inspect_recent', 'repo_list_and_search', 'repo_read_file', 'memory_list_candidates')
          OR (tool_name = 'docs_read' AND json_valid(content)
              AND json_extract(content, '$.documentId') IN (SELECT resource_id FROM authored_resources));
    `
  },
  {
    version: 6,
    name: 'routines: one run at a time across processes',
    sql: `
      ALTER TABLE routines ADD COLUMN running_since TEXT;
    `
  },
  {
    version: 7,
    name: 'run_traces: the reply that reached Slack',
    sql: `
      ALTER TABLE run_traces ADD COLUMN delivered_text TEXT;
    `
  },
  {
    version: 8,
    name: 'waiting_items: first-class tracking of delegated tasks and owed replies',
    sql: `
      CREATE TABLE waiting_items (
        id TEXT PRIMARY KEY,
        counterparty TEXT NOT NULL,
        subject TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'email',
        thread_ref TEXT,
        due_at TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_waiting_items_status ON waiting_items(status);
      CREATE INDEX idx_waiting_items_due ON waiting_items(due_at);
    `
  },
  {
    version: 9,
    name: 'spaces: self-contained web reports, radars, and dashboards hosted on VPS',
    sql: `
      CREATE TABLE spaces (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        category TEXT NOT NULL DEFAULT 'report',
        created_by TEXT NOT NULL DEFAULT 'ellie',
        trigger_type TEXT DEFAULT 'routine',
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_spaces_status ON spaces(status);
      CREATE INDEX idx_spaces_created ON spaces(created_at);
    `
  },
  {
    version: 10,
    name: 'owner_doc_cache: cache Google Doc contents keyed by modified_time',
    sql: `
      CREATE TABLE owner_doc_cache (
        doc_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        path TEXT NOT NULL DEFAULT '',
        modified_time TEXT,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `
  },
  {
    version: 11,
    name: 'rrsi_edit_ledger: edit and evidence ledger for regularized self-improvement',
    sql: `
      ALTER TABLE routines ADD COLUMN evaluator_model TEXT;

      CREATE TABLE IF NOT EXISTS rrsi_edit_ledger (
        id TEXT PRIMARY KEY,
        component_type TEXT NOT NULL, -- 'preference' | 'memory_fact' | 'skill' | 'routine_rule'
        target_id TEXT NOT NULL,      -- candidate ID, fact ID, skill name, or routine ID
        hypothesis TEXT NOT NULL,     -- why this edit/rule was proposed
        diff_text TEXT NOT NULL,      -- the exact rule/statement added or modified
        delta_score REAL DEFAULT 0,   -- empirical utility signal (+1 approve/clean, -1 drop/refusal/revert)
        delta_cost INTEGER DEFAULT 0, -- token footprint change (estimated tokens of diff_text)
        accepted INTEGER NOT NULL DEFAULT 0, -- 1 if promoted/accepted, 0 if candidate/rejected
        status TEXT NOT NULL DEFAULT 'candidate', -- 'candidate' | 'accepted' | 'rejected' | 'pruned'
        trials INTEGER NOT NULL DEFAULT 1,
        positive_trials INTEGER NOT NULL DEFAULT 0,
        negative_trials INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rrsi_component_status ON rrsi_edit_ledger(component_type, status);
      CREATE INDEX IF NOT EXISTS idx_rrsi_target ON rrsi_edit_ledger(target_id);
    `
  },
  {
    version: 12,
    name: 'composio_tools: dynamic free tool installations and connection setup',
    sql: `
      CREATE TABLE IF NOT EXISTS composio_tools (
        tool_slug TEXT PRIMARY KEY,
        toolkit_slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        auth_mode TEXT NOT NULL DEFAULT 'NONE',
        is_free INTEGER NOT NULL DEFAULT 1,
        effect_class TEXT NOT NULL DEFAULT 'READ',
        parameters_schema_json TEXT NOT NULL DEFAULT '{}',
        connected_account_id TEXT,
        connection_status TEXT NOT NULL DEFAULT 'READY',
        auth_redirect_url TEXT,
        pending_task TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        installed_by TEXT NOT NULL DEFAULT 'owner',
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_composio_tools_enabled ON composio_tools(enabled);
      CREATE INDEX IF NOT EXISTS idx_composio_tools_toolkit ON composio_tools(toolkit_slug);
    `
  }
];

export const LEDGER_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial ledger',
    sql: `
      CREATE TABLE action_ledger (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'STAGED',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        approved_at DATETIME,
        executed_at DATETIME,
        verified_at DATETIME,
        origin_run_id TEXT,
        slack_channel TEXT,
        slack_thread_ts TEXT,
        slack_card_ts TEXT,
        batch_id TEXT,
        last_error TEXT,
        execution_attempts INTEGER DEFAULT 0,
        idempotency_key TEXT
      );
      CREATE INDEX idx_action_ledger_state ON action_ledger(state);
      CREATE INDEX idx_action_ledger_batch ON action_ledger(batch_id);
      CREATE INDEX idx_action_ledger_thread ON action_ledger(slack_thread_ts);

      -- Append-only history of action transitions
      CREATE TABLE action_ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        event_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_ledger_events_action ON action_ledger_events(action_id);
    `
  }
];

/** Applies pending migrations. Refuses a database that has tables but no migration record. */
export function migrate(db: DatabaseSync, migrations: Migration[], label: string): number[] {
  const hasMigrations = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (!hasMigrations) {
    const foreign = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
    ).get() as { name: string } | undefined;
    if (foreign) {
      // Lesson from v4: never run on another version's database
      throw new Error(`Refusing to use the ${label} database: it already contains tables (e.g. '${foreign.name}') that Ellie did not create. Point ELLIE_DATA_DIR at an empty directory.`);
    }
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
  }

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(r => r.version)
  );
  const ran: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
      ran.push(m.version);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return ran;
}

export function initializeAppDatabase(db: DatabaseSync): void {
  migrate(db, APP_MIGRATIONS, 'app');
}

export function initializeLedgerDatabase(db: DatabaseSync): void {
  migrate(db, LEDGER_MIGRATIONS, 'ledger');
}
