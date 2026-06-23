import type Database from 'better-sqlite3'

/**
 * M5 — `citations` column on `chat_session_messages`.
 *
 * The gateway attributes which records (meeting/company/contact/note) an
 * assistant answer drew on and stores them as jsonb on Neon. `chat_session_messages`
 * is a synced owned table; desktop reads its messages from local SQLite (not the
 * live API), so the column must exist locally for the desktop chat to render chips.
 *
 *   • citations TEXT — a JSON-stringified Citation[] (the sync-apply stringifies
 *     the pulled jsonb; the repo read JSON.parses it back). NULL when no sources.
 *
 * Named `citations` to MATCH the Postgres column so the owned-table sync maps it
 * by same-name snake/camel (no column alias). Idempotent via PRAGMA table_info.
 */
export function runChatMessageCitationsMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('chat_session_messages')`).all() as {
    name: string
  }[]
  if (!cols.some((c) => c.name === 'citations')) {
    db.exec(`ALTER TABLE chat_session_messages ADD COLUMN citations TEXT`)
  }
}
