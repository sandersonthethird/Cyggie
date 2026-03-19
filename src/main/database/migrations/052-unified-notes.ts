import type Database from 'better-sqlite3'

export function runUnifiedNotesMigration(db: Database.Database): void {
  // Guard: already migrated
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notes'`)
    .get()
  if (tableExists) return

  db.transaction(() => {
    db.exec(`
      CREATE TABLE notes (
        id                 TEXT PRIMARY KEY,
        title              TEXT,
        content            TEXT NOT NULL DEFAULT '',
        company_id         TEXT REFERENCES org_companies(id) ON DELETE SET NULL,
        contact_id         TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        source_meeting_id  TEXT REFERENCES meetings(id) ON DELETE SET NULL,
        theme_id           TEXT REFERENCES themes(id) ON DELETE SET NULL,
        is_pinned          INTEGER NOT NULL DEFAULT 0,
        created_by_user_id TEXT,
        updated_by_user_id TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_notes_company  ON notes(company_id);
      CREATE INDEX idx_notes_contact  ON notes(contact_id);
      CREATE INDEX idx_notes_updated  ON notes(updated_at);
      CREATE INDEX idx_notes_untagged ON notes(updated_at)
        WHERE company_id IS NULL AND contact_id IS NULL;
    `)

    // Migrate existing company_notes rows into notes (with company_id set)
    const companyNotesExist = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='company_notes'`)
      .get()
    if (companyNotesExist) {
      db.exec(`
        INSERT OR IGNORE INTO notes (
          id, title, content, company_id, source_meeting_id, theme_id,
          is_pinned, created_by_user_id, updated_by_user_id, created_at, updated_at
        )
        SELECT
          id, title, content, company_id, source_meeting_id, theme_id,
          is_pinned, created_by_user_id, updated_by_user_id, created_at, updated_at
        FROM company_notes;

        DROP TABLE company_notes;
      `)
    }

    // Migrate existing contact_notes rows into notes (with contact_id set)
    const contactNotesExist = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='contact_notes'`)
      .get()
    if (contactNotesExist) {
      db.exec(`
        INSERT OR IGNORE INTO notes (
          id, title, content, contact_id, source_meeting_id, theme_id,
          is_pinned, created_by_user_id, updated_by_user_id, created_at, updated_at
        )
        SELECT
          id, title, content, contact_id, source_meeting_id, theme_id,
          is_pinned, created_by_user_id, updated_by_user_id, created_at, updated_at
        FROM contact_notes;

        DROP TABLE contact_notes;
      `)
    }
  })()
}
