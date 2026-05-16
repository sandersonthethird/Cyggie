/**
 * Integration tests for fixConcatenatedCompanyNames() in org-company.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *
 * Fix-pass algorithm (applied in order, first match wins):
 *   1. CamelCase split:   "AcmeCorp"        → "Acme Corp"         (high confidence)
 *   2. DOMAIN_WORDS:      "redswanventures" → "Red Swan Ventures"  (medium confidence)
 *   3. Suffix regex:      "bowleycapital"   → "Bowley Capital"     (lower confidence)
 *
 * On conflict (suggested name already exists): mergeCompanies(existing, current)
 * On success: updateCompany + logAudit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { buildTestDbFull } from './_fixtures/test-db'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { fixConcatenatedCompanyNames } = await import(
  '../main/database/repositories/org-company.repo'
)

// Schema comes from the shared test-db fixture (runs the same migrations
// as production). Previously this file inlined ~165 lines of CREATE TABLE,
// which drifted from production every time a new migration shipped.

// Inserts a company with the normalized_name derived the same way normalizeCompanyName() does.
function insertCompany(id: string, name: string): void {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  testDb.prepare(
    `INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES (?, ?, ?)`
  ).run(id, name, normalized)
}

// ---------------------------------------------------------------------------

describe('fixConcatenatedCompanyNames', () => {
  beforeEach(() => {
    testDb = buildTestDbFull()
    // FK enforcement off: this test seeds ad-hoc company IDs that don't
    // satisfy production's FK constraints — but we're exercising the rename
    // logic, not referential integrity.
    testDb.pragma('foreign_keys = OFF')
  })

  // ─── Step 1: CamelCase ──────────────────────────────────────────────────────

  it('renames CamelCase company: "AcmeCorp" → "Acme Corp"', () => {
    insertCompany('co1', 'AcmeCorp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.merged).toBe(0)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      id: 'co1',
      before: 'AcmeCorp',
      after: 'Acme Corp',
      action: 'renamed',
    })
    const row = testDb.prepare('SELECT canonical_name FROM org_companies WHERE id = ?').get('co1') as { canonical_name: string }
    expect(row.canonical_name).toBe('Acme Corp')
  })

  it('renames multi-word CamelCase: "BowleyCapital" → "Bowley Capital"', () => {
    insertCompany('co1', 'BowleyCapital')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0].after).toBe('Bowley Capital')
  })

  // ─── Step 2: DOMAIN_WORDS segmentation ─────────────────────────────────────

  it('renames via DOMAIN_WORDS: "redswanventures" → "Red Swan Ventures"', () => {
    insertCompany('co1', 'redswanventures')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0]).toMatchObject({
      before: 'redswanventures',
      after: 'Red Swan Ventures',
      action: 'renamed',
    })
  })

  it('renames via DOMAIN_WORDS with new legal suffixes: "nextcorp" → "Next Corp"', () => {
    insertCompany('co1', 'nextcorp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0].after).toBe('Next Corp')
  })

  // ─── Step 3: Suffix regex fallback ─────────────────────────────────────────

  it('renames via suffix regex: "bowleycapital" → "Bowley Capital"', () => {
    insertCompany('co1', 'bowleycapital')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0]).toMatchObject({
      before: 'bowleycapital',
      after: 'Bowley Capital',
      action: 'renamed',
    })
  })

  // ─── Conflict → merge ───────────────────────────────────────────────────────

  it('merges "AcmeCorp" into existing "Acme Corp"', () => {
    insertCompany('co-canonical', 'Acme Corp')  // canonical already exists
    insertCompany('co-concat', 'AcmeCorp')      // concatenated duplicate
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
    expect(result.merged).toBe(1)
    expect(result.changes[0]).toMatchObject({
      id: 'co-concat',
      before: 'AcmeCorp',
      after: 'Acme Corp',
      action: 'merged',
    })
    // Source company should be deleted after merge
    const gone = testDb.prepare('SELECT id FROM org_companies WHERE id = ?').get('co-concat')
    expect(gone).toBeUndefined()
    // Canonical company should survive
    const canonical = testDb.prepare('SELECT id FROM org_companies WHERE id = ?').get('co-canonical')
    expect(canonical).toBeDefined()
  })

  // ─── Skip guards ───────────────────────────────────────────────────────────

  it('skips all-uppercase names (abbreviations like "IBM")', () => {
    insertCompany('co1', 'IBM')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
    expect(result.merged).toBe(0)
    expect(result.changes).toHaveLength(0)
  })

  it('skips names with length ≤ 3 ("AI")', () => {
    insertCompany('co1', 'AI')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  it('skips names that cannot be segmented ("Stripe")', () => {
    insertCompany('co1', 'Stripe')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  it('skips names containing digits', () => {
    insertCompany('co1', 'Web3Corp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  it('skips names already containing a space (idempotent guard)', () => {
    insertCompany('co1', 'Acme Corp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  // ─── Idempotency ───────────────────────────────────────────────────────────

  it('is idempotent: second run returns zero changes', () => {
    insertCompany('co1', 'AcmeCorp')
    const first = fixConcatenatedCompanyNames(null)
    expect(first.fixed).toBe(1)

    const second = fixConcatenatedCompanyNames(null)
    expect(second.fixed).toBe(0)
    expect(second.merged).toBe(0)
    expect(second.changes).toHaveLength(0)
  })

  // ─── Multiple companies in one pass ────────────────────────────────────────

  it('processes multiple companies in a single pass', () => {
    insertCompany('co1', 'AcmeCorp')
    insertCompany('co2', 'redswanventures')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(2)
    const names = result.changes.map(c => c.after)
    expect(names).toContain('Acme Corp')
    expect(names).toContain('Red Swan Ventures')
  })

  // ─── Audit logging ─────────────────────────────────────────────────────────

  it('writes an audit_log entry for each rename', () => {
    insertCompany('co1', 'AcmeCorp')
    fixConcatenatedCompanyNames('user-123')
    const log = testDb.prepare('SELECT * FROM audit_log WHERE entity_id = ?').get('co1') as {
      user_id: string; action: string; changes_json: string
    } | undefined
    expect(log).toBeDefined()
    expect(log!.user_id).toBe('user-123')
    expect(log!.action).toBe('update')
    const changes = JSON.parse(log!.changes_json)
    expect(changes.before).toBe('AcmeCorp')
    expect(changes.after).toBe('Acme Corp')
  })
})
