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
 *   │     `agent_runs.result_version_id` is a free-form text reference   │
 *   │     under both producer and stress-test kinds).                    │
 *   │                                                                   │
 *   │  Drop is safe: every persist under migration 092 failed, so the   │
 *   │  table has zero rows.                                              │
 *   └──────────────────────────────────────────────────────────────────┘
 */
export function runStressTestReportsNoFkMigration(db: Database.Database): void {
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
