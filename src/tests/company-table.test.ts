// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadColumnConfig,
  saveColumnConfig,
  DEFAULT_VISIBLE_KEYS,
  COLUMN_DEFS,
  sortRows,
  filterCompanies,
  buildUrlFilter
} from '../renderer/components/company/companyColumns'
import type { CompanySummary } from '../shared/types/company'

// ── loadColumnConfig ──────────────────────────────────────────────────────────

describe('loadColumnConfig', () => {
  const STORAGE_KEY = 'cyggie:company-table-columns'

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('returns DEFAULT_VISIBLE_KEYS when nothing stored', () => {
    const result = loadColumnConfig()
    expect(result).toEqual(DEFAULT_VISIBLE_KEYS)
  })

  it('returns stored config when all keys are valid (with default cols merged in)', () => {
    // Store full DEFAULT_VISIBLE_KEYS plus a hidden column — expect it back with that order preserved
    const stored = [...DEFAULT_VISIBLE_KEYS, 'sector']
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    const result = loadColumnConfig()
    // All stored keys are preserved in order
    expect(result.slice(0, stored.length)).toEqual(stored)
  })

  it('drops unknown keys from stored config', () => {
    const stored = ['name', 'unknownColumnXYZ', 'primaryDomain']
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    const result = loadColumnConfig()
    expect(result).not.toContain('unknownColumnXYZ')
    expect(result).toContain('name')
    expect(result).toContain('primaryDomain')
  })

  it('falls back to DEFAULT_VISIBLE_KEYS on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json[')
    const result = loadColumnConfig()
    expect(result).toEqual(DEFAULT_VISIBLE_KEYS)
  })

  it('appends new defaultVisible columns missing from stored config', () => {
    // Simulate a stored config that is missing a defaultVisible column
    const newDefaultKey = COLUMN_DEFS.find((c) => c.defaultVisible && c.key !== 'name')!.key
    const stored = DEFAULT_VISIBLE_KEYS.filter((k) => k !== newDefaultKey)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    const result = loadColumnConfig()
    expect(result).toContain(newDefaultKey)
  })
})

// ── sortRows ──────────────────────────────────────────────────────────────────

function makeCompany(overrides: Partial<CompanySummary>): CompanySummary {
  return {
    id: 'id-1',
    canonicalName: 'Test Co',
    primaryDomain: null,
    entityType: 'unknown',
    pipelineStage: null,
    priority: null,
    lastTouchpoint: null,
    contactCount: 0,
    meetingCount: 0,
    emailCount: 0,
    round: null,
    raiseSize: null,
    postMoneyValuation: null,
    arr: null,
    sector: null,
    city: null,
    state: null,
    foundingYear: null,
    employeeCountRange: null,
    leadInvestor: null,
    relationshipOwner: null,
    nextFollowupDate: null,
    ...overrides
  }
}

describe('sortRows', () => {
  const companies: CompanySummary[] = [
    makeCompany({ id: '1', canonicalName: 'Zebra', raiseSize: 5 }),
    makeCompany({ id: '2', canonicalName: 'Apple', raiseSize: 10 }),
    makeCompany({ id: '3', canonicalName: 'Mango', raiseSize: null })
  ]

  it('sorts ascending by text field', () => {
    const result = sortRows(companies, { key: 'name', dir: 'asc' }, COLUMN_DEFS)
    expect(result.map((c) => c.canonicalName)).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('sorts descending by text field', () => {
    const result = sortRows(companies, { key: 'name', dir: 'desc' }, COLUMN_DEFS)
    expect(result.map((c) => c.canonicalName)).toEqual(['Zebra', 'Mango', 'Apple'])
  })

  it('sorts ascending by number field', () => {
    const result = sortRows(companies, { key: 'raiseSize', dir: 'asc' }, COLUMN_DEFS)
    expect(result.map((c) => c.raiseSize)).toEqual([5, 10, null])
  })

  it('sorts null values last regardless of direction', () => {
    const asc = sortRows(companies, { key: 'raiseSize', dir: 'asc' }, COLUMN_DEFS)
    const desc = sortRows(companies, { key: 'raiseSize', dir: 'desc' }, COLUMN_DEFS)
    expect(asc[asc.length - 1].raiseSize).toBeNull()
    expect(desc[desc.length - 1].raiseSize).toBeNull()
  })

  it('returns original order for unknown sort key', () => {
    const result = sortRows(companies, { key: 'nonexistent', dir: 'asc' }, COLUMN_DEFS)
    expect(result).toEqual(companies)
  })

  it('returns empty array when input is empty', () => {
    const result = sortRows([], { key: 'name', dir: 'asc' }, COLUMN_DEFS)
    expect(result).toEqual([])
  })
})

// ── filterCompanies ───────────────────────────────────────────────────────────

describe('filterCompanies', () => {
  const companies: CompanySummary[] = [
    makeCompany({ id: '1', entityType: 'prospect', pipelineStage: 'screening', priority: 'high' }),
    makeCompany({ id: '2', entityType: 'portfolio', pipelineStage: 'diligence', priority: 'monitor' }),
    makeCompany({ id: '3', entityType: 'vc_fund', pipelineStage: null, priority: null })
  ]

  it('returns all companies when all filters are empty', () => {
    expect(filterCompanies(companies, [], [], [])).toHaveLength(3)
  })

  it('filters by entityType', () => {
    const result = filterCompanies(companies, ['prospect'], [], [])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('filters by pipelineStage, excluding null pipelineStage records', () => {
    const result = filterCompanies(companies, [], ['screening'], [])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
    // id='3' has null pipelineStage — must not match
    expect(result.find((c) => c.id === '3')).toBeUndefined()
  })

  it('filters by priority, excluding null priority records', () => {
    const result = filterCompanies(companies, [], [], ['high'])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('applies AND logic across multiple active filters', () => {
    // Only id='1' matches prospect AND screening AND high
    const result = filterCompanies(companies, ['prospect'], ['screening'], ['high'])
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('returns empty array when no companies match', () => {
    const result = filterCompanies(companies, ['customer'], [], [])
    expect(result).toHaveLength(0)
  })
})

// ── buildUrlFilter ────────────────────────────────────────────────────────────

describe('buildUrlFilter', () => {
  it('scope=all produces no entityTypes constraint', () => {
    const filter = buildUrlFilter('all', '', 'recent_touch')
    expect(filter.entityTypes).toBeUndefined()
  })

  it('scope=prospects constrains entityTypes to prospect', () => {
    const filter = buildUrlFilter('prospects', '', 'recent_touch')
    expect(filter.entityTypes).toEqual(['prospect'])
  })

  it('scope=vc_fund constrains entityTypes to vc_fund', () => {
    const filter = buildUrlFilter('vc_fund', '', 'recent_touch')
    expect(filter.entityTypes).toEqual(['vc_fund'])
  })

  it('passes query through trimmed', () => {
    const filter = buildUrlFilter('all', '  acme  ', 'recent_touch')
    expect(filter.query).toBe('acme')
  })

  it('empty query produces undefined query field', () => {
    const filter = buildUrlFilter('all', '', 'recent_touch')
    expect(filter.query).toBeUndefined()
  })

  it('passes sortBy to filter', () => {
    const filter = buildUrlFilter('all', '', 'name')
    expect(filter.sortBy).toBe('name')
  })
})
