import type Database from 'better-sqlite3'

/**
 * Drops + recreates `stress_test_reports` WITHOUT foreign-key constraints.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Why drop FK enforcement                                           │
 *   │                                                                   │
 *   │  Migration 092 used REFERENCES on every id column. Real-world     │
 *   │  stress-test runs failed at INSERT with a generic "FOREIGN KEY    │
 *   │  constraint failed" SQLite error — we couldn't tell which target  │
 *   │  was missing, and each failing run burned ~$0.30+ of agent cost.  │
 *   │                                                                   │
 *   │  This table is observability data, not transactional data:         │
 *   │   • No transactional invariants require strict FK enforcement.     │
 *   │   • If a memo or memo_version is later deleted, an orphan report  │
 *   │     row is fine — better than losing the report at write time.    │
 *   │   • The same pattern is used elsewhere in this app (e.g.           │
 *   │     `agent_runs.result_version_id` after migration 094).           │
 *   │                                                                   │
 *   │  CRITICAL idempotency note: migrations run on every app launch.   │
 *   │  This migration ONLY drops + recreates the table when it still   │
 *   │  has FKs (from migration 092). Once 093 has run, the table has   │
 *   │  no FKs, so subsequent launches no-op. Without this guard, the   │
 *   │  DROP wiped any persisted reports on every restart.               │
 *   └──────────────────────────────────────────────────────────────────┘
 */
export function runStressTestReportsNoFkMigration(db: Database.Database): void {
  // Idempotency guard: only act when the table still has FKs from 092.
  // If the table doesn't exist yet (fresh DB; 092 just created it), the
  // foreign_key_list returns 0 rows — but in that case 092 just ran with
  // the FK schema, so we still want to drop + recreate. Distinguish by
  // checking table existence too.
  const tableExists = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type='table' AND name='stress_test_reports'
  `).get() !== undefined

  if (!tableExists) {
    // Shouldn't happen (092 runs first), but bail safely if it does.
    return
  }

  const fks = db.prepare(`PRAGMA foreign_key_list(stress_test_reports)`).all() as unknown[]
  if (fks.length === 0) {
    // Already FK-free — this migration already ran on a prior launch.
    // Do NOT drop the table; that would wipe persisted reports.
    return
  }

  db.exec(`
    DROP TABLE IF EXISTS stress_test_reports;

    CREATE TABLE stress_test_reports (
      id                      TEXT     PRIMARY KEY,
      memo_id                 TEXT     NOT NULL,
      run_id                  TEXT     NOT NULL,
      prior_memo_version_id   TEXT     NOT NULL,
      summary                 TEXT     NOT NULL,
      concerns_json           TEXT     NOT NULL,
      evidence_json           TEXT     NOT NULL,
      recommendation          TEXT     NOT NULL DEFAULT 'proceed_with_caveats',
      cost_estimate_usd       REAL     NOT NULL DEFAULT 0,
      duration_ms             INTEGER  NOT NULL DEFAULT 0,
      tool_call_count         INTEGER  NOT NULL DEFAULT 0,
      created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by              TEXT     NOT NULL
    );

    CREATE INDEX idx_stress_test_reports_memo_id
      ON stress_test_reports(memo_id, created_at DESC);

    CREATE INDEX idx_stress_test_reports_run_id
      ON stress_test_reports(run_id);
  `)
}
