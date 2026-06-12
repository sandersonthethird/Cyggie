import type Database from 'better-sqlite3'

/**
 * Adds `is_private INTEGER NOT NULL DEFAULT 0` to `notes` — the per-note privacy
 * override. SQLite has no native boolean, so we mirror `is_pinned` (INTEGER 0/1)
 * and convert in rowToNote (`is_private === 1`). The Postgres side is a real
 * boolean (schema/notes.ts); the outbox payload carries the mapped JS boolean,
 * which validates without an INT_FLAG coerce (same path as is_pinned — see
 * packages/db/src/postgres/write-validators.ts:118).
 *
 * Semantics: a *tagged* note (company_id or contact_id) is firm-visible by
 * default (is_private = 0); flipping to 1 keeps it owner-only. Untagged notes
 * are private regardless. Enforcement lives at the gateway
 * (api-gateway/src/notes/visibility.ts); desktop SQLite is single-user, so this
 * column only needs to ride the outbox up to Neon.
 *
 * Idempotent via PRAGMA table_info check.
 */
export function runNotesIsPrivateMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('notes')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'is_private')) return
  db.exec(`ALTER TABLE notes ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`)
}
