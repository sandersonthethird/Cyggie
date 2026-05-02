/**
 * Migration 077 — sector + industries(+join) → single industry column.
 *
 * Verifies:
 *   - Backfill normalization across all 19 distinct sector values seen in the
 *     production DB (DevTools→Developer Tools, etc.)
 *   - sector column dropped, industries + org_company_industries dropped
 *   - builtin:industry and builtin:investmentSectorFocus rows seeded
 *   - re-running is a no-op
 *   - contact narrative values move to investment_sector_focus_notes
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runIndustryConsolidationMigration } from '../main/database/migrations/077-industry-consolidation'

let db: Database.Database

function buildPreMigrationDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      sector TEXT
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      investment_sector_focus TEXT
    );
    CREATE TABLE industries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE org_company_industries (
      company_id TEXT NOT NULL,
      industry_id TEXT NOT NULL,
      PRIMARY KEY (company_id, industry_id)
    );
    CREATE TABLE custom_field_definitions (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      options_json TEXT,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      show_in_list INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return d
}

function colExists(d: Database.Database, table: string, col: string): boolean {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some(c => c.name === col)
}

function tableExists(d: Database.Database, name: string): boolean {
  const r = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name)
  return r !== undefined
}

beforeEach(() => {
  db = buildPreMigrationDb()
})

describe('migration 077 — industry consolidation', () => {
  it('backfills all 19 distinct production sector values to canonical industries', () => {
    // Mapping table from the plan
    const cases: Array<[string, string]> = [
      ['DevTools', 'Developer Tools'],
      ['HRTech', 'HR Tech'],
      ['ConsumerSocial', 'Consumer Social'],
      ['CreatorEconomy', 'Creator Economy'],
      ['DTC', 'Consumer (CPG)'],
      // Pass-through (already canonical)
      ['Ecommerce', 'Ecommerce'],
      ['FinTech', 'FinTech'],
      ['HealthTech', 'HealthTech'],
      ['Gaming', 'Gaming'],
      ['Web3', 'Web3'],
      ['LegalTech', 'LegalTech'],
      ['AI', 'AI'],
      ['Marketplace', 'Marketplace'],
      ['AdTech', 'AdTech'],
      ['InsurTech', 'InsurTech'],
      ['Logistics', 'Logistics'],
      ['Travel', 'Travel'],
      ['PropTech', 'PropTech'],
      ['Workforce', 'Workforce'],
    ]

    const insert = db.prepare(`INSERT INTO org_companies (id, sector) VALUES (?, ?)`)
    cases.forEach(([sector], idx) => insert.run(`co${idx}`, sector))

    runIndustryConsolidationMigration(db)

    cases.forEach(([, expected], idx) => {
      const row = db.prepare(`SELECT industry FROM org_companies WHERE id = ?`).get(`co${idx}`) as { industry: string }
      expect(row.industry).toBe(expected)
    })
  })

  it('drops sector column and industries + org_company_industries tables', () => {
    runIndustryConsolidationMigration(db)
    expect(colExists(db, 'org_companies', 'sector')).toBe(false)
    expect(colExists(db, 'org_companies', 'industry')).toBe(true)
    expect(tableExists(db, 'industries')).toBe(false)
    expect(tableExists(db, 'org_company_industries')).toBe(false)
  })

  it('seeds builtin:industry and builtin:investmentSectorFocus', () => {
    runIndustryConsolidationMigration(db)
    const industry = db.prepare(`SELECT * FROM custom_field_definitions WHERE id = 'builtin:industry'`).get() as { field_type: string } | undefined
    expect(industry?.field_type).toBe('select')
    const sectorFocus = db.prepare(`SELECT * FROM custom_field_definitions WHERE id = 'builtin:investmentSectorFocus'`).get() as { field_type: string } | undefined
    expect(sectorFocus?.field_type).toBe('multi-select')
  })

  it('moves narrative investment_sector_focus into investment_sector_focus_notes', () => {
    db.prepare(`INSERT INTO contacts (id, investment_sector_focus) VALUES ('c1', 'Generalist; ~25% consumer; open to CPG')`).run()
    runIndustryConsolidationMigration(db)
    const row = db.prepare(`SELECT investment_sector_focus, investment_sector_focus_notes FROM contacts WHERE id = 'c1'`).get() as { investment_sector_focus: string | null; investment_sector_focus_notes: string | null }
    expect(row.investment_sector_focus).toBeNull()
    expect(row.investment_sector_focus_notes).toBe('Generalist; ~25% consumer; open to CPG')
  })

  it('is idempotent on a second run', () => {
    db.prepare(`INSERT INTO org_companies (id, sector) VALUES ('co1', 'DevTools')`).run()
    runIndustryConsolidationMigration(db)
    // Run again — should not throw, should not double-insert builtin defs
    runIndustryConsolidationMigration(db)
    const defs = db.prepare(`SELECT id FROM custom_field_definitions WHERE id = 'builtin:industry'`).all()
    expect(defs).toHaveLength(1)
    const row = db.prepare(`SELECT industry FROM org_companies WHERE id = 'co1'`).get() as { industry: string }
    expect(row.industry).toBe('Developer Tools')
  })
})
