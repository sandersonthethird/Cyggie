import type Database from 'better-sqlite3'

/**
 * Creates `stress_test_reports` — the new home for stress-test agent output.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Product model change:                                                │
 *   │                                                                       │
 *   │  Before: stress-test mutated the memo (saved a new memo_version       │
 *   │          with "## Devil's Advocate" appended). Output was buried;     │
 *   │          the analyst's voice was overwritten.                         │
 *   │                                                                       │
 *   │  After:  stress-test produces a standalone report. Memo is never      │
 *   │          touched. Reports live here, linked to memo_id + the          │
 *   │          version they reviewed.                                       │
 *   │                                                                       │
 *   │  One row per completed stress-test run. JSON fields hold the          │
 *   │  structured payload (concerns, evidence). Promoted to columns if      │
 *   │  query needs ever require it.                                         │
 *   │                                                                       │
 *   │  Backwards compat: existing investment_memo_versions rows with        │
 *   │  change_note='Stress-tested by research agent' stay where they are    │
 *   │  (legacy data). Users can still see them via the version dropdown.    │
 *   └──────────────────────────────────────────────────────────────────────┘
 */
export function runStressTestReportsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stress_test_reports (
      id                      TEXT     PRIMARY KEY,
      memo_id                 TEXT     NOT NULL REFERENCES investment_memos(id) ON DELETE CASCADE,
      run_id                  TEXT     NOT NULL REFERENCES agent_runs(id),
      prior_memo_version_id   TEXT     NOT NULL REFERENCES investment_memo_versions(id),
      summary                 TEXT     NOT NULL,
      concerns_json           TEXT     NOT NULL,
      evidence_json           TEXT     NOT NULL,
      recommendation          TEXT     NOT NULL DEFAULT 'proceed_with_caveats',
      cost_estimate_usd       REAL     NOT NULL DEFAULT 0,
      duration_ms             INTEGER  NOT NULL DEFAULT 0,
      tool_call_count         INTEGER  NOT NULL DEFAULT 0,
      created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by              TEXT     NOT NULL REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_stress_test_reports_memo_id
      ON stress_test_reports(memo_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_stress_test_reports_run_id
      ON stress_test_reports(run_id);
  `)
}
