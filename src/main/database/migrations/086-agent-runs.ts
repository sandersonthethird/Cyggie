import type Database from 'better-sqlite3'

/**
 * Persistent record of every multi-turn agent run (today: thesis stress-test
 * and memo-generate; future: per-claim re-verify, partner-meeting brief, etc.).
 * One row per run, written at start with status='running' and updated on
 * completion. Powers /dev/agent-runs dashboard and the cost-badge on the
 * Stress-test button (running average from recent rows).
 *
 * `result_version_id` is set on success to the InvestmentMemoVersion the run
 * produced. NULL on failure/abort/orphan.
 *
 * Orphan-run garbage collection: on every app launch, rows with
 * status='running' AND started_at < now() - 30min are flipped to 'orphaned'
 * (the app was killed mid-run; the in-memory AbortController is gone).
 */
export function runAgentRunsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id                  TEXT PRIMARY KEY,
      kind                TEXT NOT NULL,                  -- thesis_stress_test | memo_generate | ...
      company_id          TEXT NOT NULL,
      user_id             TEXT NOT NULL,
      mode                TEXT,
      status              TEXT NOT NULL,                  -- running | success | failed | aborted | orphaned
      started_at          TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at            TEXT,
      iterations          INTEGER NOT NULL DEFAULT 0,
      input_tokens_total  INTEGER NOT NULL DEFAULT 0,
      output_tokens_total INTEGER NOT NULL DEFAULT 0,
      cost_estimate_usd   REAL    NOT NULL DEFAULT 0,
      tool_call_count     INTEGER NOT NULL DEFAULT 0,
      web_search_count    INTEGER NOT NULL DEFAULT 0,
      error_class         TEXT,
      error_message       TEXT,
      result_version_id   TEXT,
      FOREIGN KEY (result_version_id) REFERENCES investment_memo_versions(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_company ON agent_runs(company_id, started_at DESC);
    -- Partial index for orphan-GC and in-flight checks. SQLite supports partial indexes since 3.8.
    CREATE INDEX IF NOT EXISTS idx_agent_runs_running ON agent_runs(started_at) WHERE status='running';
  `)
}
