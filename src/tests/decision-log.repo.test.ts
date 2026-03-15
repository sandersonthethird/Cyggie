/**
 * Tests for company-decision-log.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *   - getCurrentUserId → returns 'test-user'
 *   - logAudit → no-op
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

// ─── Mock: database connection ───────────────────────────────────────────────

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'test-user'
}))

vi.mock('../main/database/repositories/audit.repo', () => ({
  logAudit: () => undefined
}))

// ─── Import AFTER mocks ───────────────────────────────────────────────────────

// safeParseArray is a pure function — import it directly (no DB needed)
import { safeParseArray } from '../main/database/repositories/company-decision-log.repo'

const {
  listCompanyDecisionLogs,
  getCompanyDecisionLog,
  getLatestCompanyDecisionLog,
  createCompanyDecisionLog,
  updateCompanyDecisionLog,
  deleteCompanyDecisionLog
} = await import('../main/database/repositories/company-decision-log.repo')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      investment_size TEXT,
      ownership_pct TEXT,
      followon_investment_size TEXT,
      total_invested TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE company_decision_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      decision_date TEXT NOT NULL,
      decision_owner TEXT,
      amount_approved TEXT,
      target_ownership TEXT,
      more_if_possible INTEGER NOT NULL DEFAULT 0,
      structure TEXT,
      rationale_json TEXT NOT NULL DEFAULT '[]',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      next_steps_json TEXT NOT NULL DEFAULT '[]',
      linked_artifacts_json TEXT NOT NULL DEFAULT '[]',
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );
  `)
  db.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES ('co1', 'Acme Corp')`).run()
  return db
}

// ─── safeParseArray ───────────────────────────────────────────────────────────

describe('safeParseArray', () => {
  it('returns array for valid JSON array', () => {
    expect(safeParseArray('["a","b"]')).toEqual(['a', 'b'])
  })

  it('returns [] for malformed JSON', () => {
    expect(safeParseArray('not json')).toEqual([])
  })

  it('returns [] for empty string', () => {
    expect(safeParseArray('')).toEqual([])
  })

  it('returns [] for null-ish string "null"', () => {
    // JSON.parse('null') returns null, not array
    expect(safeParseArray('null')).toEqual([])
  })

  it('returns [] for JSON object (not array)', () => {
    expect(safeParseArray('{"key":"val"}')).toEqual([])
  })
})

// ─── CRUD ─────────────────────────────────────────────────────────────────────

describe('createCompanyDecisionLog', () => {
  beforeEach(() => { testDb = buildDb() })

  it('creates a log and returns it', () => {
    const log = createCompanyDecisionLog({
      companyId: 'co1',
      decisionType: 'Pass',
      decisionDate: '2026-01-10',
      decisionOwner: 'Alice',
      amountApproved: null,
      targetOwnership: null,
      moreIfPossible: false,
      structure: null,
      rationale: ['Not a fit'],
      dependencies: [],
      nextSteps: [],
      linkedArtifacts: []
    }, 'test-user')

    expect(log.id).toBeTruthy()
    expect(log.companyId).toBe('co1')
    expect(log.decisionType).toBe('Pass')
    expect(log.decisionOwner).toBe('Alice')
    expect(log.rationale).toEqual(['Not a fit'])
    expect(log.moreIfPossible).toBe(false)
  })

  it('auto-syncs investment_size and ownership_pct for Investment Approved', () => {
    createCompanyDecisionLog({
      companyId: 'co1',
      decisionType: 'Investment Approved',
      decisionDate: '2026-03-14',
      decisionOwner: null,
      amountApproved: '$2M',
      targetOwnership: '10%',
      moreIfPossible: true,
      structure: null,
      rationale: [],
      dependencies: [],
      nextSteps: [],
      linkedArtifacts: []
    }, 'test-user')

    const company = testDb.prepare('SELECT investment_size, ownership_pct FROM org_companies WHERE id = ?').get('co1') as {
      investment_size: string | null
      ownership_pct: string | null
    }
    expect(company.investment_size).toBe('$2M')
    expect(company.ownership_pct).toBe('10%')
  })

  it('does NOT auto-sync for Pass decision type', () => {
    createCompanyDecisionLog({
      companyId: 'co1',
      decisionType: 'Pass',
      decisionDate: '2026-03-14',
      decisionOwner: null,
      amountApproved: '$1M',
      targetOwnership: '5%',
      moreIfPossible: false,
      structure: null,
      rationale: [],
      dependencies: [],
      nextSteps: [],
      linkedArtifacts: []
    }, 'test-user')

    const company = testDb.prepare('SELECT investment_size, ownership_pct FROM org_companies WHERE id = ?').get('co1') as {
      investment_size: string | null
      ownership_pct: string | null
    }
    expect(company.investment_size).toBeNull()
    expect(company.ownership_pct).toBeNull()
  })

  it('auto-syncs for Follow-on decision type', () => {
    createCompanyDecisionLog({
      companyId: 'co1',
      decisionType: 'Follow-on',
      decisionDate: '2026-03-14',
      decisionOwner: null,
      amountApproved: '$500K',
      targetOwnership: null,
      moreIfPossible: false,
      structure: null,
      rationale: [],
      dependencies: [],
      nextSteps: [],
      linkedArtifacts: []
    }, 'test-user')

    const company = testDb.prepare('SELECT investment_size FROM org_companies WHERE id = ?').get('co1') as {
      investment_size: string | null
    }
    expect(company.investment_size).toBe('$500K')
  })
})

describe('listCompanyDecisionLogs', () => {
  beforeEach(() => { testDb = buildDb() })

  it('returns empty array when no logs', () => {
    expect(listCompanyDecisionLogs('co1')).toEqual([])
  })

  it('returns logs ordered by decision_date DESC', () => {
    createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2025-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Investment Approved', decisionDate: '2026-03-14', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Follow-on', decisionDate: '2025-06-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')

    const logs = listCompanyDecisionLogs('co1')
    expect(logs.map(l => l.decisionDate)).toEqual(['2026-03-14', '2025-06-01', '2025-01-01'])
  })

  it('only returns logs for the given company', () => {
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES ('co2', 'Other Corp')`).run()
    createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2026-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    createCompanyDecisionLog({ companyId: 'co2', decisionType: 'Pass', decisionDate: '2026-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')

    expect(listCompanyDecisionLogs('co1')).toHaveLength(1)
    expect(listCompanyDecisionLogs('co2')).toHaveLength(1)
  })
})

describe('getCompanyDecisionLog', () => {
  beforeEach(() => { testDb = buildDb() })

  it('returns null for unknown id', () => {
    expect(getCompanyDecisionLog('nonexistent')).toBeNull()
  })

  it('returns the log by id', () => {
    const created = createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2026-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    const fetched = getCompanyDecisionLog(created.id)
    expect(fetched?.id).toBe(created.id)
    expect(fetched?.decisionType).toBe('Pass')
  })
})

describe('getLatestCompanyDecisionLog', () => {
  beforeEach(() => { testDb = buildDb() })

  it('returns null when no logs', () => {
    expect(getLatestCompanyDecisionLog('co1')).toBeNull()
  })

  it('returns the most recent log by decision_date', () => {
    createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2025-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Investment Approved', decisionDate: '2026-03-14', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')

    const latest = getLatestCompanyDecisionLog('co1')
    expect(latest?.decisionType).toBe('Investment Approved')
  })
})

describe('updateCompanyDecisionLog', () => {
  beforeEach(() => { testDb = buildDb() })

  it('updates allowed fields and returns refreshed record', () => {
    const created = createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2026-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    const updated = updateCompanyDecisionLog(created.id, { decisionOwner: 'Bob', structure: 'Direct equity' }, 'u')
    expect(updated?.decisionOwner).toBe('Bob')
    expect(updated?.structure).toBe('Direct equity')
  })

  it('returns null for unknown logId', () => {
    const result = updateCompanyDecisionLog('nonexistent', { decisionOwner: 'Bob' }, 'u')
    expect(result).toBeNull()
  })

  it('throws for unknown/disallowed update key', () => {
    const created = createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2026-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    expect(() => updateCompanyDecisionLog(created.id, { injectedField: 'evil' } as Record<string, unknown>, 'u')).toThrow()
  })
})

describe('deleteCompanyDecisionLog', () => {
  beforeEach(() => { testDb = buildDb() })

  it('deletes an existing log and returns true', () => {
    const created = createCompanyDecisionLog({ companyId: 'co1', decisionType: 'Pass', decisionDate: '2026-01-01', decisionOwner: null, amountApproved: null, targetOwnership: null, moreIfPossible: false, structure: null, rationale: [], dependencies: [], nextSteps: [], linkedArtifacts: [] }, 'u')
    expect(deleteCompanyDecisionLog(created.id)).toBe(true)
    expect(getCompanyDecisionLog(created.id)).toBeNull()
  })

  it('returns false for unknown id', () => {
    expect(deleteCompanyDecisionLog('nonexistent')).toBe(false)
  })
})
