import type Database from 'better-sqlite3'

/**
 * Drop the FK on `agent_runs.result_version_id`.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Why                                                              │
 *   │                                                                   │
 *   │  Migration 086 defined `result_version_id TEXT, FOREIGN KEY       │
 *   │  (result_version_id) REFERENCES investment_memo_versions(id) ON   │
 *   │  DELETE SET NULL`. That made sense when the column always pointed │
 *   │  at a memo_version (memo_producer kind).                          │
 *   │                                                                   │
 *   │  After the stress-test redesign, the column is GENERIC artifact   │
 *   │  reference:                                                       │
 *   │    kind='memo_producer'       → memo_version_id                   │
 *   │    kind='thesis_stress_test'  → stress_test_report_id             │
 *   │                                                                   │
 *   │  Stress-test report ids are NOT in investment_memo_versions, so   │
 *   │  the FK fires SQLITE_CONSTRAINT_FOREIGNKEY at the completeRun     │
 *   │  UPDATE — even though the report itself persisted fine. Outer     │
 *   │  catch then marks the run as failed, losing the report from the   │
 *   │  user's POV.                                                      │
 *   │                                                                   │
 *   │  SQLite doesn't support `ALTER TABLE … DROP CONSTRAINT`. Standard │
 *   │  pattern: create a new table without the FK, copy rows over, drop │
 *   │  the old, rename. Wrapped in a transaction to avoid partial state.│
 *   │                                                                   │
 *   │  Indexes preserved: idx_agent_runs_company and the partial        │
 *   │  idx_agent_runs_running both get recreated against the new table. │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * NOTE: this migration uses table-recreate. To make it idempotent for fresh
 * DBs that never ran 086 (which can't happen in practice — 086 ships first
 * in the migration list), we guard with a column-presence check at the top.
 */
export function runAgentRunsDropVersionFkMigration(db: Database.Database): void {
  // Detect whether the FK is still there. Newly-created agent_runs from this
  // migration onward has no FK. If foreign_key_list is empty (or doesn't
  // include result_version_id), this migration is a no-op.
  const fks = db.prepare(`PRAGMA foreign_key_list(agent_runs);`).all() as Array<{ from: string }>
  const hasVersionFk = fks.some(fk => fk.from === 'result_version_id')
  if (!hasVersionFk) return

  // Recreate the table without the FK. Preserve all existing data,
  // migrations 086+091 schema (with the cache_*_tokens_total columns).
  db.exec(`
    BEGIN TRANSACTION;

    CREATE TABLE agent_runs_new (
      id                                TEXT PRIMARY KEY,
      kind                              TEXT NOT NULL,
      company_id                        TEXT NOT NULL,
      user_id                           TEXT NOT NULL,
      mode                              TEXT,
      status                            TEXT NOT NULL,
      started_at                        TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at                          TEXT,
      iterations                        INTEGER NOT NULL DEFAULT 0,
      input_tokens_total                INTEGER NOT NULL DEFAULT 0,
      output_tokens_total               INTEGER NOT NULL DEFAULT 0,
      cost_estimate_usd                 REAL    NOT NULL DEFAULT 0,
      tool_call_count                   INTEGER NOT NULL DEFAULT 0,
      web_search_count                  INTEGER NOT NULL DEFAULT 0,
      error_class                       TEXT,
      error_message                     TEXT,
      result_version_id                 TEXT,
      cache_read_input_tokens_total     INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens_total INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO agent_runs_new (
      id, kind, company_id, user_id, mode, status, started_at, ended_at,
      iterations, input_tokens_total, output_tokens_total, cost_estimate_usd,
      tool_call_count, web_search_count, error_class, error_message,
      result_version_id, cache_read_input_tokens_total, cache_creation_input_tokens_total
    )
    SELECT
      id, kind, company_id, user_id, mode, status, started_at, ended_at,
      iterations, input_tokens_total, output_tokens_total, cost_estimate_usd,
      tool_call_count, web_search_count, error_class, error_message,
      result_version_id, cache_read_input_tokens_total, cache_creation_input_tokens_total
    FROM agent_runs;

    DROP TABLE agent_runs;
    ALTER TABLE agent_runs_new RENAME TO agent_runs;

    CREATE INDEX IF NOT EXISTS idx_agent_runs_company ON agent_runs(company_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_running ON agent_runs(started_at) WHERE status='running';

    COMMIT;
  `)
}
