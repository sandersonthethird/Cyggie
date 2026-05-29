import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_110_company_key_takeaways_user_note'

/**
 * Adds `key_takeaways_user_note` to `org_companies`. User-authored note pinned
 * to the top of the Key Takeaways card; survives AI regeneration and is fed
 * to the LLM as known truth. Nullable so existing rows need no backfill.
 */
export function runCompanyKeyTakeawaysUserNoteMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  if (!new Set(columns.map((c) => c.name)).has('key_takeaways_user_note')) {
    db.exec('ALTER TABLE org_companies ADD COLUMN key_takeaways_user_note TEXT')
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(MIGRATION_KEY, new Date().toISOString())
}
