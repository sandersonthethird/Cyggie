import type Database from 'better-sqlite3'

export function runFtsMigration(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(
      meeting_id UNINDEXED,
      title,
      transcript_text,
      summary_text,
      content='',
      tokenize='porter unicode61'
    );
  `)
}
