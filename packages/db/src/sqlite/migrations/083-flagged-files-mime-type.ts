import type Database from 'better-sqlite3'

/**
 * Phase 2: add a `mime_type` column to `company_flagged_files` so the chat-
 * context reader can dispatch local-file vs Google-native paths without
 * sniffing the file_id.
 *
 * Existing rows leave `mime_type` NULL (all are local files flagged before
 * phase 2; the dispatcher falls back to filesystem stat and extension when
 * the column is null). New flag inserts populate it from the listing's
 * mimeType field (`pdf`, `docx`, `xlsx`, or `application/vnd.google-apps.*`).
 *
 * Idempotent: detects the column via PRAGMA table_info before adding.
 */
export function runFlaggedFilesMimeTypeMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(company_flagged_files)') as Array<{ name: string }>
  if (cols.some((c) => c.name === 'mime_type')) return
  db.exec(`ALTER TABLE company_flagged_files ADD COLUMN mime_type TEXT`)
}
