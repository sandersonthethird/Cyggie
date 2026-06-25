import type Database from 'better-sqlite3'

/**
 * M5 — `attachment_uploads`: a LOCAL, NON-synced queue of image bytes waiting to
 * be uploaded to object storage ("byte outbox").
 *
 * Pasting an image writes the bytes to the local cache + enqueues a row here, so
 * the paste is instant and never blocks on the network (mirrors how a note write
 * lands in SQLite + the sync outbox immediately). A background flusher drains
 * this queue once the user is signed in + online: upload bytes → create the
 * synced `attachments` metadata row → delete the queue row.
 *
 * This is operational state like the `outbox` table (migration 097): it is NOT
 * an owned/synced table, carries no lamport, and never reaches Neon. Idempotent.
 */
export function runAttachmentUploadsMigration(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='attachment_uploads'`)
    .get()
  if (exists) return

  db.exec(`
    CREATE TABLE attachment_uploads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      attachment_id TEXT NOT NULL,
      user_id       TEXT,
      owner_type    TEXT NOT NULL,
      owner_id      TEXT NOT NULL,
      filename      TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      checksum      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'failed' | 'dead'
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_uploads_status ON attachment_uploads(status, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attachment_uploads_attachment ON attachment_uploads(attachment_id);
  `)
}
