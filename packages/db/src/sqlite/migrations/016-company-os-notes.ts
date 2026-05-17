import type Database from 'better-sqlite3'

export function runCompanyOsNotesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS company_notes (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      theme_id TEXT,
      title TEXT,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_company_notes_company ON company_notes(company_id);
    CREATE INDEX IF NOT EXISTS idx_company_notes_updated ON company_notes(updated_at);
  `)
}
