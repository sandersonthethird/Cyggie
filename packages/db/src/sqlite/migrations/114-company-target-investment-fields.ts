import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_114_company_target_investment_v1'

/**
 * Adds investment-thesis-fit fields to the company Overview panel:
 *   - target_investment_stage  — single-select stage value (e.g. 'seed')
 *   - target_investment_sector — multi-select sector, stored CSV (e.g. 'FinTech,SaaS')
 *
 * Both are registered as builtin company custom-field definitions (mirror
 * migrations 046 / 077) so the Overview dropdowns and the Add-Field picker
 * pick them up. The single-select uses field_type 'select'; the multi-select
 * uses 'multi-select' (same shape as contact investmentSectorFocus).
 *
 * Also relabels the contact builtin defs to the new investment-thesis naming:
 *   investmentSectorFocus  'Sector Focus' → 'Target Investment Sector'
 * (investmentStageFocus is a plain-text field with no builtin def — its label
 * lives only in the renderer constants.)
 *
 * Column adds are idempotent via PRAGMA; the seed/relabel run once via the
 * settings guard so a user's later label edits aren't reset on each launch.
 * The matching Neon columns ship in packages/db/migrations/0033_company_target_investment.sql;
 * org_companies syncs whole-row, so no OWNED_TABLES change is needed.
 */
export function runCompanyTargetInvestmentFieldsMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('target_investment_stage')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN target_investment_stage TEXT`)
  }
  if (!columnNames.has('target_investment_sector')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN target_investment_sector TEXT`)
  }

  // Builtin field defs for the new company Overview dropdowns.
  db.exec(`
    INSERT OR IGNORE INTO custom_field_definitions
      (id, entity_type, field_key, label, field_type, options_json, is_builtin,
       is_required, sort_order, show_in_list, created_at, updated_at)
    VALUES
      ('builtin:targetInvestmentStage',  'company', 'targetInvestmentStage',  'Target Investment Stage',  'multi-select', NULL, 1, 0, -91, 0, datetime('now'), datetime('now')),
      ('builtin:targetInvestmentSector', 'company', 'targetInvestmentSector', 'Target Investment Sector', 'multi-select', NULL, 1, 0, -90, 0, datetime('now'), datetime('now'))
  `)

  // Relabel the contact sector-focus builtin to the new investment-thesis naming.
  db.exec(`
    UPDATE custom_field_definitions
       SET label = 'Target Investment Sector', updated_at = datetime('now')
     WHERE id = 'builtin:investmentSectorFocus'
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
