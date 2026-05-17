import type Database from 'better-sqlite3'

export function runCompanyDecisionLogsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_decision_logs (
      id                    TEXT PRIMARY KEY,
      company_id            TEXT NOT NULL,
      decision_type         TEXT NOT NULL,
      decision_date         TEXT NOT NULL,
      decision_owner        TEXT,
      amount_approved       TEXT,
      target_ownership      TEXT,
      more_if_possible      INTEGER NOT NULL DEFAULT 0,
      structure             TEXT,
      rationale_json        TEXT NOT NULL DEFAULT '[]',
      dependencies_json     TEXT NOT NULL DEFAULT '[]',
      next_steps_json       TEXT NOT NULL DEFAULT '[]',
      linked_artifacts_json TEXT NOT NULL DEFAULT '[]',
      created_by_user_id    TEXT,
      updated_by_user_id    TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_decision_logs_company
      ON company_decision_logs(company_id);

    CREATE INDEX IF NOT EXISTS idx_decision_logs_date
      ON company_decision_logs(company_id, decision_date DESC);
  `)
}
