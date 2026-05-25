import type Database from 'better-sqlite3'

/**
 * Per-chat Anthropic prompt-caching toggle.
 *
 * When true (1), the gateway tags the context-block segment of the system
 * prompt with `cache_control: ephemeral` so multi-turn chats read from cache
 * on turn 2+ at ~0.1× input cost. When false (0), the cache marker is
 * omitted — useful for one-shot questions where the 1.25× cache-write
 * premium wouldn't pay back.
 *
 * SQLite has no native boolean — store as INTEGER 0/1 to mirror is_pinned /
 * is_archived. drizzle-zod auto-derives validators from the Postgres
 * (`boolean`) column for sync push/pull; the desktop sync layer maps
 * boolean ↔ 0/1 on the wire.
 *
 * Default 1 preserves the pre-toggle behavior for existing chat_sessions
 * rows (which previously cached unconditionally). Idempotent: PRAGMA-checked
 * before ALTER. Safe to re-run.
 */
export function runChatSessionCacheEnabledMigration(
  db: Database.Database,
): void {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_sessions'`)
    .get() as { name: string } | undefined
  if (!tableExists) return

  const cols = db.prepare(`PRAGMA table_info('chat_sessions')`).all() as {
    name: string
  }[]
  const hasColumn = cols.some((c) => c.name === 'cache_enabled')
  if (hasColumn) return

  db.exec(
    `ALTER TABLE chat_sessions ADD COLUMN cache_enabled INTEGER NOT NULL DEFAULT 1`,
  )
}
