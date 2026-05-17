import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_037_company_extra_fields_v1'

export function runCompanyExtraFieldsMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  console.log('[migration-037] running...')

  const columns = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  // Firmographic / Business Profile
  if (!columnNames.has('founding_year')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN founding_year INTEGER`)
  }
  if (!columnNames.has('employee_count_range')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN employee_count_range TEXT`)
  }
  if (!columnNames.has('hq_address')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN hq_address TEXT`)
  }
  if (!columnNames.has('linkedin_company_url')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN linkedin_company_url TEXT`)
  }
  if (!columnNames.has('twitter_handle')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN twitter_handle TEXT`)
  }
  if (!columnNames.has('crunchbase_url')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN crunchbase_url TEXT`)
  }
  if (!columnNames.has('angellist_url')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN angellist_url TEXT`)
  }
  if (!columnNames.has('sector')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN sector TEXT`)
  }
  if (!columnNames.has('target_customer')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN target_customer TEXT`)
  }
  if (!columnNames.has('business_model')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN business_model TEXT`)
  }
  if (!columnNames.has('product_stage')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN product_stage TEXT`)
  }
  if (!columnNames.has('revenue_model')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN revenue_model TEXT`)
  }

  // Financials
  if (!columnNames.has('arr')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN arr REAL`)
  }
  if (!columnNames.has('burn_rate')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN burn_rate REAL`)
  }
  if (!columnNames.has('runway_months')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN runway_months INTEGER`)
  }
  if (!columnNames.has('last_funding_date')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN last_funding_date TEXT`)
  }
  if (!columnNames.has('total_funding_raised')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN total_funding_raised REAL`)
  }
  if (!columnNames.has('lead_investor')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN lead_investor TEXT`)
  }
  if (!columnNames.has('co_investors')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN co_investors TEXT`)
  }

  // Deal Provenance
  if (!columnNames.has('relationship_owner')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN relationship_owner TEXT`)
  }
  if (!columnNames.has('deal_source')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN deal_source TEXT`)
  }
  if (!columnNames.has('warm_intro_source')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN warm_intro_source TEXT`)
  }
  if (!columnNames.has('referral_contact_id')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN referral_contact_id TEXT`)
  }
  if (!columnNames.has('next_followup_date')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN next_followup_date TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())

  console.log('[migration-037] done')
}
