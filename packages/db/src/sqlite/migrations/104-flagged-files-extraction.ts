import type Database from 'better-sqlite3'

/**
 * Phase 3 — pre-extracted text for company_flagged_files.
 *
 * Adds the columns needed to:
 *   1. Persist file text at flag time (not query time) — `extracted_text`,
 *      `extracted_text_chars`, `extracted_at`.
 *   2. Drive a durable extraction queue — `extraction_status`,
 *      `extraction_error`.
 *   3. Multiplayer attribution + Drive-version invalidation —
 *      `flagged_by_user_id`, `drive_version`.
 *   4. Wire the table into the existing sync outbox — `user_id`, `lamport`.
 *
 * Existing rows are marked `extraction_status = 'pending'` so the
 * background worker drains them over time (backfill UX: status chip
 * shows "extracting…" until each row completes).
 *
 * `user_id` is added nullable — the desktop worker backfills it from
 * the authenticated user on first run (single-user-per-device, so
 * inferring the owner of pre-Phase-3 flags is safe).
 *
 * SQLite has no native JSON or boolean — status stored as TEXT, ints
 * stored as INTEGER. Idempotent: PRAGMA-checked before each ALTER.
 * Safe to re-run.
 */
export function runFlaggedFilesExtractionMigration(
  db: Database.Database,
): void {
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'company_flagged_files'`,
    )
    .get() as { name: string } | undefined
  if (!tableExists) return

  const cols = db
    .prepare(`PRAGMA table_info('company_flagged_files')`)
    .all() as { name: string }[]
  const has = (name: string): boolean => cols.some((c) => c.name === name)

  // ADD COLUMN statements. SQLite restricts adding NOT NULL columns
  // without a constant default; we use the same constant-default pattern
  // as migration 096's lamport addition.
  if (!has('extracted_text')) {
    db.exec(`ALTER TABLE company_flagged_files ADD COLUMN extracted_text TEXT`)
  }
  if (!has('extracted_text_chars')) {
    db.exec(
      `ALTER TABLE company_flagged_files ADD COLUMN extracted_text_chars INTEGER`,
    )
  }
  if (!has('drive_version')) {
    db.exec(`ALTER TABLE company_flagged_files ADD COLUMN drive_version TEXT`)
  }
  if (!has('flagged_by_user_id')) {
    db.exec(
      `ALTER TABLE company_flagged_files ADD COLUMN flagged_by_user_id TEXT`,
    )
  }
  if (!has('extraction_status')) {
    db.exec(
      `ALTER TABLE company_flagged_files ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending'`,
    )
  }
  if (!has('extraction_error')) {
    db.exec(
      `ALTER TABLE company_flagged_files ADD COLUMN extraction_error TEXT`,
    )
  }
  if (!has('extracted_at')) {
    db.exec(`ALTER TABLE company_flagged_files ADD COLUMN extracted_at TEXT`)
  }
  if (!has('lamport')) {
    db.exec(
      `ALTER TABLE company_flagged_files ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`,
    )
  }
  if (!has('user_id')) {
    // Nullable — worker backfills from authenticated user on first run.
    db.exec(`ALTER TABLE company_flagged_files ADD COLUMN user_id TEXT`)
  }

  // Backfill: any pre-Phase-3 row that doesn't already have
  // extracted_text needs to be enqueued for the worker. The DEFAULT 'pending'
  // on extraction_status already handles this for newly-added column case,
  // but if this migration runs more than once OR if someone manually
  // updated a row, double-check by setting any row with NULL extracted_text
  // back to 'pending'. Idempotent.
  db.exec(
    `UPDATE company_flagged_files
     SET extraction_status = 'pending'
     WHERE extracted_text IS NULL AND extraction_status != 'failed'`,
  )
}
