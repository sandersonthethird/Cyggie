import type Database from 'better-sqlite3'

export function runDropCompanyConversationsMigration(db: Database.Database): void {
  // Sanity check: log if any rows exist (the renderer never wrote to these
  // tables, so they should always be empty). Wrap in try/catch — if the table
  // doesn't exist, we still want the DROP to run idempotently.
  try {
    const row = db
      .prepare(`SELECT COUNT(*) as n FROM company_conversations`)
      .get() as { n: number } | undefined
    if (row && row.n > 0) {
      console.warn(
        `[migration 079] dropping company_conversations with ${row.n} rows — these were never reachable from the UI`
      )
    }
  } catch {
    // Table doesn't exist yet — fine.
  }

  db.exec(`
    DROP TABLE IF EXISTS company_conversation_messages;
    DROP TABLE IF EXISTS company_conversations;
  `)
}
