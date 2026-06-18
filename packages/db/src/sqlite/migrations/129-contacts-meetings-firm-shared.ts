import type Database from 'better-sqlite3'

/**
 * Phase 4 multiplayer — make contacts + meetings firm-shared (field-LWW),
 * soft-deletable, and privacy-aware. Adds, idempotently, to BOTH tables:
 *
 *   • field_lamports TEXT       — per-column clocks (JSON map) for field-LWW.
 *   • is_private INTEGER NOT NULL DEFAULT 0 — owner-only opt-out (0=shared).
 *   • deleted_at TEXT           — soft-delete (mirrors org_companies/tasks).
 *   • deleted_by_user_id TEXT
 *
 * firm_id is NOT added on SQLite (desktop is single-firm; the gateway stamps
 * firm_id from the JWT and firm-scopes the pull). contacts/meetings already
 * carry `lamport` (existing owned tables). Idempotent via PRAGMA checks.
 */
function addColumns(db: Database.Database, table: 'contacts' | 'meetings'): void {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]
  const has = (name: string): boolean => cols.some((c) => c.name === name)

  if (!has('field_lamports')) db.exec(`ALTER TABLE ${table} ADD COLUMN field_lamports TEXT`)
  if (!has('is_private')) db.exec(`ALTER TABLE ${table} ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`)
  if (!has('deleted_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`)
  if (!has('deleted_by_user_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_by_user_id TEXT`)
}

export function runContactsMeetingsFirmSharedMigration(db: Database.Database): void {
  addColumns(db, 'contacts')
  addColumns(db, 'meetings')
}
