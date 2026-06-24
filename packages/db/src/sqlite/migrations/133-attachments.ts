import type Database from 'better-sqlite3'

/**
 * M5 — `attachments` table: metadata for note/memo inline images + PDFs.
 *
 * The BYTES live in Cloudflare R2 (out-of-band, via presigned URLs); only these
 * small metadata rows sync via the outbox. A reference inside note/memo markdown
 * is `cyggie-attachment://{id}` — the desktop protocol handler resolves it through
 * this row's `storage_key` to a local cache (downloaded from R2 on miss).
 *
 *   owner_type/owner_id — 'note'|'memo' + notes.id|investment_memos.id
 *   storage_key         — R2 object key, 'attachments/{userId}/{id}'
 *   checksum            — sha256 hex (integrity check on download)
 *   kind                — 'image' | 'pdf'
 *
 * SYNC SHAPE (matches the firmScoped owned-table precedent — contacts/meetings):
 *   • NO local `firm_id` — the desktop is single-firm; the gateway stamps firm_id
 *     from JWT on push and firm-scopes the pull (see sync.ts, 125-tasks-field-lww).
 *   • Local `user_id` IS kept so the desktop attachment-GC can scope soft-deletes
 *     to the current user's OWN rows (a teammate's attachment referenced only in
 *     their non-pulled private note must never be false-orphaned). The gateway
 *     re-stamps user_id from JWT (no-op match on single-user desktop).
 *   • Insert + soft-delete only (never field-edited) → whole-row LWW, so no
 *     field_lamports and no largeColumns.
 *
 * Column names MATCH the Postgres table so the owned-table sync maps them by
 * same-name snake/camel (no alias). Idempotent via sqlite_master check.
 */
export function runAttachmentsMigration(db: Database.Database): void {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'`)
    .get()
  if (exists) return

  db.exec(`
    CREATE TABLE attachments (
      id          TEXT PRIMARY KEY,
      owner_type  TEXT NOT NULL,
      owner_id    TEXT NOT NULL,
      user_id     TEXT,
      kind        TEXT NOT NULL,
      filename    TEXT NOT NULL,
      mime_type   TEXT NOT NULL,
      size_bytes  INTEGER NOT NULL,
      storage_key TEXT NOT NULL,
      checksum    TEXT,
      width       INTEGER,
      height      INTEGER,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at  TEXT,
      lamport     TEXT NOT NULL DEFAULT '0'
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);
  `)
}
