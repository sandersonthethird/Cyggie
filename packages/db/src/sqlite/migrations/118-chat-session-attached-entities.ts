import type Database from 'better-sqlite3'

/**
 * Attached context entities: a per-session list of companies/contacts whose
 * full context is folded into the AI Chat prompt. Drives both the in-panel
 * context chips and the LLM context builder (`queryEntities`).
 *
 * SQLite has no native JSON column — store as TEXT holding a JSON-encoded
 * array of `{ type: 'company' | 'contact', id, label }`. The gateway-side
 * Postgres column is jsonb; drizzle-zod auto-derives the sync validator from
 * the Postgres schema, so the outbox round-trip works once the column exists
 * on both sides.
 *
 * Added with DEFAULT '[]' so existing chat_sessions rows get a sensible empty
 * value without backfill. Idempotent: PRAGMA-checked before ALTER.
 *
 * (Generalizes migration 102's company-only `selected_company_ids` to mixed
 * company + contact refs — see [[project_notes_feature]].)
 */
export function runChatSessionAttachedEntitiesMigration(
  db: Database.Database,
): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions'`)
    .get() as { name: string } | undefined
  if (!tableExists) return // chat_sessions not present yet — earlier migration was skipped

  const cols = db.prepare(`PRAGMA table_info('chat_sessions')`).all() as {
    name: string
  }[]
  const hasColumn = cols.some((c) => c.name === 'attached_context_entities')
  if (hasColumn) return

  db.exec(
    `ALTER TABLE chat_sessions ADD COLUMN attached_context_entities TEXT NOT NULL DEFAULT '[]'`,
  )
}
