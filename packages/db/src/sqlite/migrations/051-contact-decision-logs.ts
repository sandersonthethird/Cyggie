import Database from 'better-sqlite3'

export function runContactDecisionLogsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_decision_logs (
      id                    TEXT PRIMARY KEY,
      contact_id            TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      decision_type         TEXT NOT NULL,
      decision_date         TEXT NOT NULL,
      decision_owner        TEXT,
      rationale_json        TEXT NOT NULL DEFAULT '[]',
      next_steps_json       TEXT NOT NULL DEFAULT '[]',
      created_by_user_id    TEXT,
      updated_by_user_id    TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contact_decision_logs_contact
      ON contact_decision_logs(contact_id);
  `)
}
