import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_038_contact_extra_fields_v2'

export function runContactExtraFieldsV2Migration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  console.log('[migration-038] running...')

  const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('phone')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN phone TEXT`)
  }
  if (!columnNames.has('twitter_handle')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN twitter_handle TEXT`)
  }
  if (!columnNames.has('other_socials')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN other_socials TEXT`)
  }
  if (!columnNames.has('timezone')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN timezone TEXT`)
  }
  if (!columnNames.has('pronouns')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN pronouns TEXT`)
  }
  if (!columnNames.has('birthday')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN birthday TEXT`)
  }
  if (!columnNames.has('university')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN university TEXT`)
  }
  if (!columnNames.has('previous_companies')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN previous_companies TEXT`)
  }
  if (!columnNames.has('tags')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN tags TEXT`)
  }
  if (!columnNames.has('relationship_strength')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN relationship_strength TEXT`)
  }
  if (!columnNames.has('last_met_event')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN last_met_event TEXT`)
  }
  if (!columnNames.has('warm_intro_path')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN warm_intro_path TEXT`)
  }

  // Investor-specific
  if (!columnNames.has('fund_size')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN fund_size REAL`)
  }
  if (!columnNames.has('typical_check_size_min')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN typical_check_size_min REAL`)
  }
  if (!columnNames.has('typical_check_size_max')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN typical_check_size_max REAL`)
  }
  if (!columnNames.has('investment_stage_focus')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN investment_stage_focus TEXT`)
  }
  if (!columnNames.has('investment_sector_focus')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN investment_sector_focus TEXT`)
  }
  if (!columnNames.has('proud_portfolio_companies')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN proud_portfolio_companies TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())

  console.log('[migration-038] done')
}
