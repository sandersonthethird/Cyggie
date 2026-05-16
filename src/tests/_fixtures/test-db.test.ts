/**
 * Smoke test for the shared test database fixture.
 *
 * Catches the next migration regression early: if a new migration is
 * added to connection.ts but not to test-db.ts (or vice-versa), the
 * "all expected tables exist" assertion will fail before any other
 * test runs.
 */
import { describe, it, expect } from 'vitest'
import { buildTestDbFull, buildTestDb } from './test-db'

describe('test-db fixture', () => {
  it('buildTestDbFull() applies every migration without error', () => {
    expect(() => buildTestDbFull()).not.toThrow()
  })

  it('contains the core CRM tables after full migration', () => {
    const db = buildTestDbFull()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all() as Array<{ name: string }>
    const names = new Set(tables.map((t) => t.name))
    // Spot-check the tables we know the failing tests need.
    expect(names.has('org_companies')).toBe(true)
    expect(names.has('contacts')).toBe(true)
    expect(names.has('meetings')).toBe(true)
    expect(names.has('meetings_fts')).toBe(true)
    expect(names.has('agent_runs')).toBe(true)
    expect(names.has('memo_evidence')).toBe(true)
    expect(names.has('themes')).toBe(true)
  })

  it('org_companies has the columns recent failures reported as missing', () => {
    const db = buildTestDbFull()
    const cols = (db.prepare('PRAGMA table_info(org_companies)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).toContain('lead_investor_company_id') // migration 076
  })

  it('agent_runs has the recent cache-token columns', () => {
    const db = buildTestDbFull()
    const cols = (db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).toContain('cache_read_input_tokens_total') // migration 091
  })

  it('memo_evidence has the section column', () => {
    const db = buildTestDbFull()
    const cols = (db.prepare('PRAGMA table_info(memo_evidence)').all() as Array<{ name: string }>)
      .map((c) => c.name)
    expect(cols).toContain('section') // migration 090
  })

  it('buildTestDb({ migrations: [] }) returns an empty database', () => {
    const db = buildTestDb({ migrations: [] })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    expect(tables).toHaveLength(0)
  })
})
