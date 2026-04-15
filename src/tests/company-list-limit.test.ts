/**
 * Regression test: listCompanies limit behavior
 *
 * Root cause captured 2026-04-14: buildUrlFilter passed limit: 400 to listCompanies.
 * With 760 companies in the DB, portfolio companies at sort positions 521–747 were
 * silently dropped before reaching the renderer, making them invisible in the
 * Companies table even when their entity_type was correct.
 *
 * Fix: buildUrlFilter no longer passes a limit. listCompanies skips the LIMIT clause
 * when filter.limit is undefined, returning all matching rows.
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { listCompanies } = await import('../main/database/repositories/org-company.repo')

// Minimal schema — only columns referenced by baseCompanySelectLight
function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL DEFAULT '',
      description TEXT,
      primary_domain TEXT,
      website_url TEXT,
      city TEXT,
      state TEXT,
      stage TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      crm_provider TEXT,
      crm_company_id TEXT,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      include_in_companies_view INTEGER NOT NULL DEFAULT 1,
      classification_source TEXT NOT NULL DEFAULT 'manual',
      classification_confidence REAL,
      priority TEXT,
      post_money_valuation REAL,
      raise_size REAL,
      round TEXT,
      pipeline_stage TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  return db
}

function insertCompany(db: Database.Database, name: string, entityType = 'portfolio'): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO org_companies (id, canonical_name, normalized_name, entity_type, include_in_companies_view)
    VALUES (?, ?, ?, ?, 1)
  `).run(id, name, name.toLowerCase(), entityType)
  return id
}

describe('listCompanies — limit behavior', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('returns exactly limit rows when limit is set', () => {
    for (let i = 0; i < 5; i++) insertCompany(testDb, `Company ${i}`)
    const results = listCompanies({ view: 'all', limit: 3 })
    expect(results).toHaveLength(3)
  })

  it('returns all rows when limit is undefined', () => {
    for (let i = 0; i < 5; i++) insertCompany(testDb, `Company ${i}`)
    const results = listCompanies({ view: 'all' })
    expect(results).toHaveLength(5)
  })

  it('companies cut by a low limit are present in an unlimited fetch', () => {
    const ids = Array.from({ length: 5 }, (_, i) => insertCompany(testDb, `Company ${i}`))
    const capped = listCompanies({ view: 'all', limit: 3 })
    const cappedIds = new Set(capped.map((c) => c.id))
    const extra = ids.filter((id) => !cappedIds.has(id))
    // With limit: 3, 2 companies are dropped
    expect(extra).toHaveLength(2)
    // Without limit, all 5 are returned
    const all = listCompanies({ view: 'all' })
    const allIds = new Set(all.map((c) => c.id))
    extra.forEach((id) => expect(allIds.has(id)).toBe(true))
  })

  it('portfolio companies beyond sort rank 400 are returned when there is no limit', () => {
    // Simulate the production scenario: insert companies with old updated_at so they sort late.
    // Insert 5 "old" companies (would be ranked low in a large DB), then verify they're returned.
    for (let i = 0; i < 3; i++) {
      testDb.prepare(`
        INSERT INTO org_companies (id, canonical_name, normalized_name, entity_type, include_in_companies_view, updated_at)
        VALUES (?, ?, ?, 'portfolio', 1, '2020-01-0${i + 1}')
      `).run(randomUUID(), `Old Portfolio ${i}`, `old portfolio ${i}`)
    }
    // Also insert "newer" companies that would sort above
    for (let i = 0; i < 3; i++) {
      testDb.prepare(`
        INSERT INTO org_companies (id, canonical_name, normalized_name, entity_type, include_in_companies_view, updated_at)
        VALUES (?, ?, ?, 'prospect', 1, '2026-04-1${i + 1}')
      `).run(randomUUID(), `New Prospect ${i}`, `new prospect ${i}`)
    }
    // With no limit all 6 are returned; without this fix, a limit: 3 would drop the old portfolio ones
    const all = listCompanies({ view: 'all' })
    expect(all).toHaveLength(6)
    const portfolioRows = all.filter((c) => c.entityType === 'portfolio')
    expect(portfolioRows).toHaveLength(3)
  })
})
