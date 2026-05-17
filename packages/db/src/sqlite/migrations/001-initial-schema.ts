import type Database from 'better-sqlite3'

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      duration_seconds INTEGER,
      calendar_event_id TEXT,
      meeting_platform TEXT,
      meeting_url TEXT,
      transcript_path TEXT,
      summary_path TEXT,
      template_id TEXT,
      speaker_count INTEGER DEFAULT 0,
      speaker_map TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'recording',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (template_id) REFERENCES templates(id)
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);
    CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      user_prompt_template TEXT NOT NULL,
      output_format TEXT DEFAULT 'markdown',
      is_default BOOLEAN DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS speakers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meeting_speakers (
      meeting_id TEXT NOT NULL,
      speaker_index INTEGER NOT NULL,
      speaker_id TEXT,
      label TEXT NOT NULL DEFAULT 'Speaker',
      PRIMARY KEY (meeting_id, speaker_index),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY (speaker_id) REFERENCES speakers(id) ON DELETE SET NULL
    );
  `)
}
