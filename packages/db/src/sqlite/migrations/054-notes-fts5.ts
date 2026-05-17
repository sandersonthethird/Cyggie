import type Database from 'better-sqlite3'

export function runNotesFts5Migration(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      id UNINDEXED,
      title,
      content
    );

    -- Backfill existing notes (idempotent via INSERT OR IGNORE equivalent — FTS5
    -- doesn't support OR IGNORE, so we skip rows already present by checking count)
    INSERT INTO notes_fts(id, title, content)
    SELECT n.id, COALESCE(n.title, ''), n.content
    FROM notes n
    WHERE n.id NOT IN (SELECT id FROM notes_fts);

    -- Keep FTS5 in sync with the notes table
    CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(id, title, content)
        VALUES(new.id, COALESCE(new.title, ''), new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
      DELETE FROM notes_fts WHERE id = old.id;
    END;

    CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE ON notes BEGIN
      DELETE FROM notes_fts WHERE id = old.id;
      INSERT INTO notes_fts(id, title, content)
        VALUES(new.id, COALESCE(new.title, ''), new.content);
    END;
  `)
}
