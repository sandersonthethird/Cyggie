import type Database from 'better-sqlite3'

export function runCompanyOsArtifactsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      theme_id TEXT,
      meeting_id TEXT,
      artifact_type TEXT NOT NULL,
      title TEXT NOT NULL,
      mime_type TEXT,
      storage_uri TEXT,
      source_provider TEXT,
      source_external_id TEXT,
      content_text TEXT,
      captured_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE SET NULL,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE SET NULL,
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_company ON artifacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_theme ON artifacts(theme_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_meeting ON artifacts(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);

    CREATE TABLE IF NOT EXISTS meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (meeting_id, company_id),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meeting_theme_links (
      meeting_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (meeting_id, theme_id),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
      FOREIGN KEY (theme_id) REFERENCES themes(id) ON DELETE CASCADE
    );
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
      artifact_id UNINDEXED,
      title,
      content_text,
      tokenize='porter unicode61'
    );
  `)

  const emailCols = db.prepare("PRAGMA table_info('email_messages')").all() as { name: string }[]
  if (emailCols.some((c) => c.name === 'artifact_id')) {
    // Keep artifacts foreign-key relationship best-effort and idempotent.
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_messages_artifact ON email_messages(artifact_id)')
  }

  const attachmentCols = db.prepare("PRAGMA table_info('email_attachments')").all() as { name: string }[]
  if (attachmentCols.some((c) => c.name === 'artifact_id')) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_attachments_artifact ON email_attachments(artifact_id)')
  }
}
