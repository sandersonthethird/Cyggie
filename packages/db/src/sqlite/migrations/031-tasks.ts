import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_031_tasks_v1'

export function runTasksMigration(db: Database.Database): void {
  up(db)
}

function up(db: Database.Database): void {
  const applied = db
    .prepare(`SELECT 1 FROM settings WHERE key = ?`)
    .get(MIGRATION_KEY)

  if (applied) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      meeting_id TEXT,
      company_id TEXT,
      contact_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      category TEXT NOT NULL DEFAULT 'action_item',
      priority TEXT,
      assignee TEXT,
      due_date TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      source_section TEXT,
      extraction_hash TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL,
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE SET NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_meeting_id ON tasks(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_company_id ON tasks(company_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_extraction_hash ON tasks(extraction_hash);
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
