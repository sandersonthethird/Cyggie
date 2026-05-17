import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_071_meeting_dismissed_companies'

export function runMeetingDismissedCompaniesMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(meetings)') as Array<{ name: string }>
  if (!new Set(columns.map((c) => c.name)).has('dismissed_companies')) {
    db.exec('ALTER TABLE meetings ADD COLUMN dismissed_companies TEXT')
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(MIGRATION_KEY, new Date().toISOString())
}
