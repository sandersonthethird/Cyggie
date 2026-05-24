import type Database from 'better-sqlite3'

/**
 * Phase 2 (Mobile Chat): per-session list of selected company IDs whose
 * context the gateway injects into the LLM system prompt for the global
 * "Ask Cyggie" chat.
 *
 * SQLite has no native JSON column — store as TEXT holding a JSON-encoded
 * string array. Mobile and gateway both treat the field as `string[]`;
 * the gateway-side Postgres column is jsonb. drizzle-zod auto-derives
 * the validator for sync push/pull from the Postgres schema, so the
 * outbox round-trip "just works" once the column exists on both sides.
 *
 * The column is added with DEFAULT '[]' so existing chat_sessions rows
 * (created pre-Phase-2) get a sensible empty value without backfill.
 *
 * Idempotent: PRAGMA-checked before ALTER. Safe to re-run.
 */
export function runChatSessionSelectedCompaniesMigration(
  db: Database.Database,
): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions'`)
    .get() as { name: string } | undefined
  if (!tableExists) return // chat_sessions not present yet — earlier migration was skipped

  const cols = db.prepare(`PRAGMA table_info('chat_sessions')`).all() as {
    name: string
  }[]
  const hasColumn = cols.some((c) => c.name === 'selected_company_ids')
  if (hasColumn) return

  db.exec(
    `ALTER TABLE chat_sessions ADD COLUMN selected_company_ids TEXT NOT NULL DEFAULT '[]'`,
  )
}
