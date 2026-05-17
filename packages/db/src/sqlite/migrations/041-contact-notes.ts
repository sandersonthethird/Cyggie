import type Database from 'better-sqlite3'

export function runContactNotesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      theme_id TEXT,
      title TEXT,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contact_notes_contact ON contact_notes(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_notes_updated ON contact_notes(updated_at);
  `)
}
