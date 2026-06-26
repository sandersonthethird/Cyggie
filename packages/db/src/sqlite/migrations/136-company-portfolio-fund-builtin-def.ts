import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_136_company_portfolio_fund_builtin_def_v1'

/**
 * Registers `portfolioFund` ("Portfolio") as a user-extensible builtin company
 * select field (mirrors migrations 046 / 077 / 114).
 *
 * Until now Portfolio was a fixed enum (Fund I…Fund V / Personal) with no way
 * to add firm-specific buckets. The shipped defaults still live in shared code
 * (PORTFOLIO_FUND_OPTIONS), but — like `round` / `industry` — the field now
 * merges any firm-added options from this builtin def's options_json on top, so
 * users can define their own via the inline "+ Add option" affordance.
 *
 * That inline editor only persists when a `builtin:<key>` row exists to hang
 * options_json off of. This seeds that row with options_json = NULL (the six
 * defaults come from shared code, not from here — this only holds firm extras).
 *
 * The `portfolio_fund` column itself already exists (migration 072), and
 * org_companies syncs whole-row, so no column add or OWNED_TABLES change is
 * needed here. Seeded once via the settings guard so later label/option edits
 * aren't reset on each launch.
 *
 * TODO(multi-firm): the Fund I…Fund V defaults are Red-Swan-specific. The
 * broader per-firm-type column/option preset work should move them out of
 * shared code into firm-seeded config (so a non-VC firm starts with its own).
 */
export function runCompanyPortfolioFundBuiltinDefMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  db.exec(`
    INSERT OR IGNORE INTO custom_field_definitions
      (id, entity_type, field_key, label, field_type, options_json, is_builtin,
       is_required, sort_order, show_in_list, created_at, updated_at)
    VALUES
      ('builtin:portfolioFund', 'company', 'portfolioFund', 'Portfolio', 'select', NULL, 1, 0, -89, 0, datetime('now'), datetime('now'))
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
