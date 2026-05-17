import type Database from 'better-sqlite3'

export function runUserPreferencesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}
