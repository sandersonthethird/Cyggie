// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadColumnConfig,
  saveColumnConfig,
  DEFAULT_VISIBLE_KEYS,
  COLUMN_DEFS,
  filterCompanies,
  buildUrlFilter
} from '../renderer/components/company/companyColumns'
import { filterContacts } from '../renderer/components/contact/contactColumns'
import { needsSwap } from '../renderer/components/crm/RangeFilter'
import {
  applyRangeFilter,
  applyTextFilter,
  applySelectFilter,
  applyCustomSelectFilter,
  applyCustomRangeFilter,
  applyCustomTextFilter,
  splitFiltersByCustom,
  createColumnWidthsHelper,
  sortRows
} from '../renderer/components/crm/tableUtils'
import type { CompanySummary } from '../shared/types/company'
import type { ContactSummary } from '../shared/types/contact'

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
    const stored = [...DEFAULT_VISIBLE_KEYS, 'industry']
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
    industry: null,
    city: null,
    state: null,
    foundingYear: null,
    employeeCountRange: null,
    leadInvestor: null,
    relationshipOwner: null,
    nextFollowupDate: null,
    createdAt: '2024-01-01 00:00:00',
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
    const result = sortRows(companies, [{ key: 'name', dir: 'asc' }], COLUMN_DEFS)
    expect(result.map((c) => c.canonicalName)).toEqual(['Apple', 'Mango', 'Zebra'])
  })

  it('sorts descending by text field', () => {
    const result = sortRows(companies, [{ key: 'name', dir: 'desc' }], COLUMN_DEFS)
    expect(result.map((c) => c.canonicalName)).toEqual(['Zebra', 'Mango', 'Apple'])
  })

  it('sorts ascending by number field', () => {
    const result = sortRows(companies, [{ key: 'raiseSize', dir: 'asc' }], COLUMN_DEFS)
    expect(result.map((c) => c.raiseSize)).toEqual([5, 10, null])
  })

  it('sorts null values last regardless of direction', () => {
    const asc = sortRows(companies, [{ key: 'raiseSize', dir: 'asc' }], COLUMN_DEFS)
    const desc = sortRows(companies, [{ key: 'raiseSize', dir: 'desc' }], COLUMN_DEFS)
    expect(asc[asc.length - 1].raiseSize).toBeNull()
    expect(desc[desc.length - 1].raiseSize).toBeNull()
  })

  it('returns original order for unknown sort key', () => {
    const result = sortRows(companies, [{ key: 'nonexistent', dir: 'asc' }], COLUMN_DEFS)
    expect(result).toEqual(companies)
  })

  it('returns empty array when input is empty', () => {
    const result = sortRows([], [{ key: 'name', dir: 'asc' }], COLUMN_DEFS)
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

  it('returns all companies when filters is empty object', () => {
    expect(filterCompanies(companies, { columnFilters: {} })).toHaveLength(3)
  })

  it('filters by entityType', () => {
    const result = filterCompanies(companies, { columnFilters: { entityType: ['prospect'] } })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('filters by pipelineStage, excluding null pipelineStage records', () => {
    const result = filterCompanies(companies, { columnFilters: { pipelineStage: ['screening'] } })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
    // id='3' has null pipelineStage — must not match
    expect(result.find((c) => c.id === '3')).toBeUndefined()
  })

  it('filters by priority, excluding null priority records', () => {
    const result = filterCompanies(companies, { columnFilters: { priority: ['high'] } })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('applies AND logic across multiple active filters', () => {
    // Only id='1' matches prospect AND screening AND high
    const result = filterCompanies(companies, {
      columnFilters: {
        entityType: ['prospect'],
        pipelineStage: ['screening'],
        priority: ['high']
      }
    })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('returns empty array when no companies match', () => {
    const result = filterCompanies(companies, { columnFilters: { entityType: ['customer'] } })
    expect(result).toHaveLength(0)
  })

  it('multi-select: returns all matching values for a single field', () => {
    const result = filterCompanies(companies, { columnFilters: { entityType: ['prospect', 'portfolio'] } })
    expect(result.map((c) => c.id).sort()).toEqual(['1', '2'])
  })
})

// ── filterCompanies — generic forward-compatible filters ──────────────────────

describe('filterCompanies — generic filters', () => {
  const companies: CompanySummary[] = [
    makeCompany({ id: '1', entityType: 'prospect', round: 'seed', pipelineStage: 'screening' }),
    makeCompany({ id: '2', entityType: 'portfolio', round: 'series_a', pipelineStage: null }),
    makeCompany({ id: '3', entityType: 'prospect', round: null, pipelineStage: null })
  ]

  it('empty filters passes all companies', () => {
    expect(filterCompanies(companies, { columnFilters: {} }).map((c) => c.id)).toEqual(['1', '2', '3'])
  })

  it('single field filter works', () => {
    expect(filterCompanies(companies, { columnFilters: { round: ['seed'] } }).map((c) => c.id)).toEqual(['1'])
  })

  it('null cell value is excluded when filter is active', () => {
    const result = filterCompanies(companies, { columnFilters: { round: ['seed'] } })
    expect(result.find((c) => c.id === '3')).toBeUndefined()
  })

  it('multiple fields are ANDed', () => {
    expect(
      filterCompanies(companies, { columnFilters: { entityType: ['prospect'], round: ['seed'] } }).map((c) => c.id)
    ).toEqual(['1'])
  })
})

// ── buildUrlFilter ────────────────────────────────────────────────────────────

describe('buildUrlFilter', () => {
  it('produces no entityTypes constraint', () => {
    const filter = buildUrlFilter('', 'recent_touch')
    expect(filter.entityTypes).toBeUndefined()
  })

  it('passes query through trimmed', () => {
    const filter = buildUrlFilter('  acme  ', 'recent_touch')
    expect(filter.query).toBe('acme')
  })

  it('empty query produces undefined query field', () => {
    const filter = buildUrlFilter('', 'recent_touch')
    expect(filter.query).toBeUndefined()
  })

  it('passes sortBy to filter', () => {
    const filter = buildUrlFilter('', 'name')
    expect(filter.sortBy).toBe('name')
  })
})

// ── filterCompanies — range filters ───────────────────────────────────────────

describe('filterCompanies — range filters', () => {
  it('date lte includes records ON the boundary date (SQLite datetime format)', () => {
    // Critical: SQLite stores 'YYYY-MM-DD HH:MM:SS'; must .slice(0,10) before comparing
    // '2024-01-15 10:30:00' > '2024-01-15' lexicographically, so without normalization
    // a ≤ filter would incorrectly exclude the boundary record.
    const companies = [
      makeCompany({ id: '1', createdAt: '2024-01-15 10:30:00' }), // ON boundary → include
      makeCompany({ id: '2', createdAt: '2024-01-16 00:00:00' }), // after → exclude
      makeCompany({ id: '3', createdAt: '2024-01-14 23:59:59' })  // before → include
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { createdAt: { max: '2024-01-15' } } })
    expect(result.map((c) => c.id).sort()).toEqual(['1', '3'])
  })

  it('eq filter (min === max) matches only exact numeric value', () => {
    const companies = [
      makeCompany({ id: '1', foundingYear: 2020 }),
      makeCompany({ id: '2', foundingYear: 2021 }),
      makeCompany({ id: '3', foundingYear: 2019 })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { foundingYear: { min: '2020', max: '2020' } } })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('gte filter includes values at and above the minimum', () => {
    const companies = [
      makeCompany({ id: '1', raiseSize: 5 }),
      makeCompany({ id: '2', raiseSize: 10 }),
      makeCompany({ id: '3', raiseSize: 3 })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { raiseSize: { min: '5' } } })
    expect(result.map((c) => c.id).sort()).toEqual(['1', '2'])
  })

  it('lte filter includes values at and below the maximum', () => {
    const companies = [
      makeCompany({ id: '1', raiseSize: 5 }),
      makeCompany({ id: '2', raiseSize: 10 }),
      makeCompany({ id: '3', raiseSize: 3 })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { raiseSize: { max: '5' } } })
    expect(result.map((c) => c.id).sort()).toEqual(['1', '3'])
  })

  it('between filter includes values within the range (inclusive)', () => {
    const companies = [
      makeCompany({ id: '1', raiseSize: 5 }),
      makeCompany({ id: '2', raiseSize: 10 }),
      makeCompany({ id: '3', raiseSize: 3 }),
      makeCompany({ id: '4', raiseSize: 20 })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { raiseSize: { min: '5', max: '15' } } })
    expect(result.map((c) => c.id).sort()).toEqual(['1', '2'])
  })

  it('null values are excluded when a range filter is active', () => {
    const companies = [
      makeCompany({ id: '1', raiseSize: 5 }),
      makeCompany({ id: '2', raiseSize: null })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { raiseSize: { min: '1' } } })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('empty string min/max (cleared URL param) passes all rows — not filtered by 0', () => {
    const companies = [
      makeCompany({ id: '1', raiseSize: 5 }),
      makeCompany({ id: '2', raiseSize: 0 }),
      makeCompany({ id: '3', raiseSize: null })
    ]
    // An empty-string range should effectively be no filter
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { raiseSize: { min: '', max: '' } } })
    expect(result.map((c) => c.id)).toEqual(['1', '2', '3'])
  })

  it('date gte filter works', () => {
    const companies = [
      makeCompany({ id: '1', createdAt: '2024-06-01 00:00:00' }),
      makeCompany({ id: '2', createdAt: '2023-12-31 00:00:00' })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: { createdAt: { min: '2024-01-01' } } })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('select + range filters AND together', () => {
    const companies = [
      makeCompany({ id: '1', entityType: 'prospect', raiseSize: 10 }),
      makeCompany({ id: '2', entityType: 'portfolio', raiseSize: 10 }),
      makeCompany({ id: '3', entityType: 'prospect', raiseSize: 2 })
    ]
    const result = filterCompanies(companies, { columnFilters: { entityType: ['prospect'] }, rangeFilters: { raiseSize: { min: '5' } } })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })
})

// ── filterCompanies — text filters ────────────────────────────────────────────

describe('filterCompanies — text filters', () => {
  it('text filter is case-insensitive and partial-match', () => {
    const companies = [
      makeCompany({ id: '1', industry: 'FinTech' }),
      makeCompany({ id: '2', industry: 'healthcare' }),
      makeCompany({ id: '3', industry: null })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: {}, textFilters: { industry: 'fintech' } })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('null cell value is excluded when text filter is active', () => {
    const companies = [
      makeCompany({ id: '1', industry: 'FinTech' }),
      makeCompany({ id: '2', industry: null })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: {}, textFilters: { industry: 'fin' } })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('empty string text filter passes all rows', () => {
    const companies = [
      makeCompany({ id: '1', industry: 'FinTech' }),
      makeCompany({ id: '2', industry: null })
    ]
    const result = filterCompanies(companies, { columnFilters: {}, rangeFilters: {}, textFilters: { industry: '' } })
    expect(result.map((c) => c.id)).toEqual(['1', '2'])
  })

  it('select + range + text all AND together (three-pass chain)', () => {
    const companies = [
      makeCompany({ id: '1', entityType: 'prospect', raiseSize: 10, industry: 'FinTech' }),
      makeCompany({ id: '2', entityType: 'prospect', raiseSize: 10, industry: 'Healthcare' }),
      makeCompany({ id: '3', entityType: 'portfolio', raiseSize: 10, industry: 'FinTech' }),
      makeCompany({ id: '4', entityType: 'prospect', raiseSize: 2, industry: 'FinTech' })
    ]
    const result = filterCompanies(companies, {
      columnFilters: { entityType: ['prospect'] },
      rangeFilters: { raiseSize: { min: '5' } },
      textFilters: { industry: 'fintech' }
    })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })
})

// ── filterContacts — range + text filters ─────────────────────────────────────

function makeContact(overrides: Partial<ContactSummary>): ContactSummary {
  return {
    id: 'c-1',
    fullName: 'Test Contact',
    firstName: 'Test',
    lastName: 'Contact',
    normalizedName: 'test contact',
    email: null,
    primaryCompanyId: null,
    primaryCompanyName: null,
    title: null,
    contactType: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    meetingCount: 0,
    emailCount: 0,
    lastTouchpoint: null,
    createdAt: '2024-01-01 00:00:00',
    ...overrides
  }
}

describe('filterContacts — range + text filters', () => {
  it('date boundary: lte includes records ON the boundary date (SQLite datetime format)', () => {
    const contacts = [
      makeContact({ id: 'c1', createdAt: '2024-01-15 10:30:00' }), // ON boundary → include
      makeContact({ id: 'c2', createdAt: '2024-01-16 00:00:00' }), // after → exclude
      makeContact({ id: 'c3', createdAt: '2024-01-14 23:59:59' })  // before → include
    ]
    const result = filterContacts(contacts, { columnFilters: {}, rangeFilters: { createdAt: { max: '2024-01-15' } } })
    expect(result.map((c) => c.id).sort()).toEqual(['c1', 'c3'])
  })

  it('text filter: case-insensitive contains on email', () => {
    const contacts = [
      makeContact({ id: 'c1', email: 'alice@gmail.com' }),
      makeContact({ id: 'c2', email: 'bob@corp.com' }),
      makeContact({ id: 'c3', email: null })
    ]
    const result = filterContacts(contacts, { columnFilters: {}, rangeFilters: {}, textFilters: { email: '@gmail' } })
    expect(result.map((c) => c.id)).toEqual(['c1'])
  })

  it('select + text AND together', () => {
    const contacts = [
      makeContact({ id: 'c1', contactType: 'investor', email: 'alice@gmail.com' }),
      makeContact({ id: 'c2', contactType: 'founder', email: 'bob@gmail.com' }),
      makeContact({ id: 'c3', contactType: 'investor', email: 'carol@corp.com' })
    ]
    const result = filterContacts(contacts, {
      columnFilters: { contactType: ['investor'] },
      rangeFilters: {},
      textFilters: { email: '@gmail' }
    })
    expect(result.map((c) => c.id)).toEqual(['c1'])
  })
})

// ── needsSwap ─────────────────────────────────────────────────────────────────

describe('needsSwap', () => {
  it('returns true when val1 > val2 for numbers', () => {
    expect(needsSwap('100', '5', 'number')).toBe(true)
  })

  it('returns false when val1 <= val2 for numbers', () => {
    expect(needsSwap('5', '100', 'number')).toBe(false)
  })

  it('returns true when val1 > val2 for dates (lexicographic)', () => {
    expect(needsSwap('2024-12-01', '2024-01-01', 'date')).toBe(true)
  })

  it('returns false when val1 <= val2 for dates', () => {
    expect(needsSwap('2024-01-01', '2024-12-01', 'date')).toBe(false)
  })

  it('returns false when either value is empty (no swap possible)', () => {
    expect(needsSwap('', '100', 'number')).toBe(false)
    expect(needsSwap('100', '', 'number')).toBe(false)
    expect(needsSwap('', '', 'number')).toBe(false)
  })
})

// ── applyRangeFilter + applyTextFilter (tableUtils) ───────────────────────────

describe('applyRangeFilter', () => {
  type Row = { id: string; val: number | null }

  it('returns all rows when rangeFilters is empty', () => {
    const rows: Row[] = [{ id: '1', val: 5 }, { id: '2', val: null }]
    expect(applyRangeFilter(rows as Record<string, unknown>[], {})).toHaveLength(2)
  })

  it('numeric gte excludes values below minimum', () => {
    const rows: Row[] = [{ id: '1', val: 5 }, { id: '2', val: 3 }]
    const result = applyRangeFilter(rows as Record<string, unknown>[], { val: { min: '5' } })
    expect(result.map((r) => (r as Row).id)).toEqual(['1'])
  })

  it('numeric lte excludes values above maximum', () => {
    const rows: Row[] = [{ id: '1', val: 5 }, { id: '2', val: 10 }]
    const result = applyRangeFilter(rows as Record<string, unknown>[], { val: { max: '7' } })
    expect(result.map((r) => (r as Row).id)).toEqual(['1'])
  })
})

describe('applyTextFilter', () => {
  type Row = { id: string; name: string | null }

  it('returns all rows when textFilters is empty', () => {
    const rows: Row[] = [{ id: '1', name: 'foo' }, { id: '2', name: null }]
    expect(applyTextFilter(rows as Record<string, unknown>[], {})).toHaveLength(2)
  })

  it('empty string query passes all rows', () => {
    const rows: Row[] = [{ id: '1', name: 'foo' }, { id: '2', name: null }]
    expect(applyTextFilter(rows as Record<string, unknown>[], { name: '   ' })).toHaveLength(2)
  })

  it('case-insensitive partial match', () => {
    const rows: Row[] = [{ id: '1', name: 'FooBar' }, { id: '2', name: 'baz' }]
    const result = applyTextFilter(rows as Record<string, unknown>[], { name: 'foo' })
    expect(result.map((r) => (r as Row).id)).toEqual(['1'])
  })

  it('null cell value is excluded when filter is active', () => {
    const rows: Row[] = [{ id: '1', name: 'foo' }, { id: '2', name: null }]
    const result = applyTextFilter(rows as Record<string, unknown>[], { name: 'foo' })
    expect(result.map((r) => (r as Row).id)).toEqual(['1'])
  })
})

// ── applySelectFilter ─────────────────────────────────────────────────────────

describe('applySelectFilter', () => {
  type Row = { id: string; type: string | null }

  it('empty filters passes all rows', () => {
    const rows: Row[] = [{ id: '1', type: 'a' }, { id: '2', type: 'b' }]
    expect(applySelectFilter(rows as Record<string, unknown>[], {})).toHaveLength(2)
  })

  it('null cell value is excluded when filter is active', () => {
    const rows: Row[] = [{ id: '1', type: 'a' }, { id: '2', type: null }]
    const result = applySelectFilter(rows as Record<string, unknown>[], { type: ['a'] })
    expect(result.map((r) => (r as Row).id)).toEqual(['1'])
  })

  it('multi-value filter (OR) matches any value in the list', () => {
    const rows: Row[] = [
      { id: '1', type: 'a' },
      { id: '2', type: 'b' },
      { id: '3', type: 'c' }
    ]
    const result = applySelectFilter(rows as Record<string, unknown>[], { type: ['a', 'b'] })
    expect(result.map((r) => (r as Row).id)).toEqual(['1', '2'])
  })

  it('multi-field AND: both fields must match', () => {
    const rows = [
      { id: '1', type: 'a', status: 'open' },
      { id: '2', type: 'a', status: 'closed' },
      { id: '3', type: 'b', status: 'open' }
    ]
    const result = applySelectFilter(rows as Record<string, unknown>[], { type: ['a'], status: ['open'] })
    expect(result.map((r) => r.id)).toEqual(['1'])
  })
})

// ── createColumnWidthsHelper ──────────────────────────────────────────────────

describe('createColumnWidthsHelper', () => {
  const KEY = 'test:widths'

  beforeEach(() => localStorage.removeItem(KEY))
  afterEach(() => localStorage.removeItem(KEY))

  it('load returns {} when localStorage is empty', () => {
    const { load } = createColumnWidthsHelper(KEY)
    expect(load()).toEqual({})
  })

  it('save persists and load reads back', () => {
    const { load, save } = createColumnWidthsHelper(KEY)
    save({ name: 200, email: 160 })
    expect(load()).toEqual({ name: 200, email: 160 })
  })

  it('load returns {} on JSON parse error', () => {
    localStorage.setItem(KEY, 'not-json')
    const { load } = createColumnWidthsHelper(KEY)
    expect(load()).toEqual({})
  })
})

// ── splitFiltersByCustom ──────────────────────────────────────────────────────

describe('splitFiltersByCustom', () => {
  it('partitions on `custom:` prefix and strips it from custom keys', () => {
    const out = splitFiltersByCustom({
      type: ['investor'],
      'custom:abc': ['B2B'],
      pipelineStage: ['screening'],
      'custom:def': ['urgent'],
    })
    expect(out.builtIn).toEqual({ type: ['investor'], pipelineStage: ['screening'] })
    expect(out.custom).toEqual({ abc: ['B2B'], def: ['urgent'] })
  })

  it('returns empty objects for empty input', () => {
    expect(splitFiltersByCustom({})).toEqual({ builtIn: {}, custom: {} })
  })

  it('handles range-shape values', () => {
    const out = splitFiltersByCustom({
      foundingYear: { min: '2020' },
      'custom:score': { min: '50', max: '100' },
    })
    expect(out.builtIn).toEqual({ foundingYear: { min: '2020' } })
    expect(out.custom).toEqual({ score: { min: '50', max: '100' } })
  })
})

// ── applyCustomSelectFilter ───────────────────────────────────────────────────

describe('applyCustomSelectFilter', () => {
  const rows = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ]

  it('returns identity when no active filters', () => {
    expect(applyCustomSelectFilter(rows, {}, {})).toEqual(rows)
  })

  it('single-select: exact match against bare cell value', () => {
    const values = { a: { focus: 'B2B' }, b: { focus: 'Consumer' }, c: {} }
    const result = applyCustomSelectFilter(rows, { focus: ['B2B'] }, values)
    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('multiselect: comma-joined cell value matches if ANY filter value is present', () => {
    const values = {
      a: { tags: 'B2B,SaaS' },
      b: { tags: 'Consumer,Hardware' },
      c: { tags: 'B2B' },
    }
    const result = applyCustomSelectFilter(rows, { tags: ['SaaS'] }, values)
    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('multiselect: matches when ANY of multiple filter values intersects cell', () => {
    const values = {
      a: { tags: 'B2B,SaaS' },
      b: { tags: 'Consumer' },
      c: { tags: 'Hardware,B2B' },
    }
    const result = applyCustomSelectFilter(rows, { tags: ['SaaS', 'Hardware'] }, values)
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c'])
  })

  it('row excluded when entityId missing from customFieldValues', () => {
    const values = { a: { focus: 'B2B' } }
    const result = applyCustomSelectFilter(rows, { focus: ['B2B'] }, values)
    expect(result.map((r) => r.id)).toEqual(['a'])
  })

  it('row excluded when cell value is empty string', () => {
    const values = { a: { focus: '' }, b: { focus: 'B2B' } }
    const result = applyCustomSelectFilter(rows, { focus: ['B2B'] }, values)
    expect(result.map((r) => r.id)).toEqual(['b'])
  })
})

// ── applyCustomRangeFilter ────────────────────────────────────────────────────

describe('applyCustomRangeFilter', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('returns identity when no active filters', () => {
    expect(applyCustomRangeFilter(rows, {}, {}, {})).toEqual(rows)
  })

  it('numeric bounds work even though custom values arrive as strings', () => {
    const values = { a: { score: '5' }, b: { score: '50' }, c: { score: '100' } }
    const types = { score: 'number' as const }
    const result = applyCustomRangeFilter(rows, { score: { min: '10', max: '75' } }, values, types)
    expect(result.map((r) => r.id)).toEqual(['b'])
  })

  it('date bounds slice to YYYY-MM-DD for boundary inclusion', () => {
    const values = {
      a: { reviewed: '2024-01-15 10:30:00' }, // ON boundary
      b: { reviewed: '2024-01-16 00:00:00' }, // after
      c: { reviewed: '2024-01-14 23:59:59' }, // before
    }
    const types = { reviewed: 'date' as const }
    const result = applyCustomRangeFilter(rows, { reviewed: { max: '2024-01-15' } }, values, types)
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c'])
  })

  it('non-numeric string in number-typed field excludes the row (no silent mis-compare)', () => {
    const values = { a: { score: 'N/A' }, b: { score: '42' }, c: { score: '' } }
    const types = { score: 'number' as const }
    const result = applyCustomRangeFilter(rows, { score: { min: '0', max: '100' } }, values, types)
    expect(result.map((r) => r.id)).toEqual(['b'])
  })

  it('empty-string min/max are treated as no bound', () => {
    const values = { a: { score: '5' }, b: { score: '50' } }
    const types = { score: 'number' as const }
    const result = applyCustomRangeFilter(rows, { score: { min: '', max: '' } }, values, types)
    // No active bounds → no filtering performed; identity for all rows (including
    // 'c' which has no value at all — untouched because the filter is inactive).
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

// ── applyCustomTextFilter ─────────────────────────────────────────────────────

describe('applyCustomTextFilter', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('returns identity when no active filters', () => {
    expect(applyCustomTextFilter(rows, {}, {})).toEqual(rows)
  })

  it('case-insensitive contains on custom values', () => {
    const values = {
      a: { notes: 'Urgent followup needed' },
      b: { notes: 'Boring quarterly check' },
      c: { notes: 'URGENT must call back' },
    }
    const result = applyCustomTextFilter(rows, { notes: 'urgent' }, values)
    expect(result.map((r) => r.id).sort()).toEqual(['a', 'c'])
  })

  it('row excluded when cell missing', () => {
    const values = { a: { notes: 'has content' } }
    const result = applyCustomTextFilter(rows, { notes: 'content' }, values)
    expect(result.map((r) => r.id)).toEqual(['a'])
  })
})

// ── filterCompanies — custom-field integration ─────────────────────────────────

describe('filterCompanies — custom-field integration', () => {
  function makeC(id: string, overrides: Partial<CompanySummary> = {}): CompanySummary {
    return {
      id,
      canonicalName: id,
      normalizedName: id.toLowerCase(),
      entityType: 'prospect',
      pipelineStage: null,
      priority: null,
      round: null,
      raiseSize: null,
      foundingYear: null,
      industry: null,
      lastTouchpoint: null,
      meetingCount: 0,
      emailCount: 0,
      contactCount: 0,
      noteCount: 0,
      createdAt: '2024-01-01 00:00:00',
      ...(overrides as Partial<CompanySummary>),
    } as CompanySummary
  }

  it('built-in select + custom select compose with AND', () => {
    const companies = [
      makeC('1', { entityType: 'prospect' }),
      makeC('2', { entityType: 'prospect' }),
      makeC('3', { entityType: 'portfolio' }),
    ]
    const customFieldValues = {
      '1': { focus: 'B2B' },
      '2': { focus: 'Consumer' },
      '3': { focus: 'B2B' },
    }
    const result = filterCompanies(companies, {
      columnFilters: { entityType: ['prospect'], 'custom:focus': ['B2B'] },
      customFieldValues,
      customFieldTypes: { focus: 'select' },
    })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('custom range + built-in range compose', () => {
    const companies = [
      makeC('1', { raiseSize: 10 }),
      makeC('2', { raiseSize: 10 }),
      makeC('3', { raiseSize: 1 }),
    ]
    const customFieldValues = {
      '1': { score: '80' },
      '2': { score: '40' },
      '3': { score: '90' },
    }
    const result = filterCompanies(companies, {
      columnFilters: {},
      rangeFilters: { raiseSize: { min: '5' }, 'custom:score': { min: '70' } },
      customFieldValues,
      customFieldTypes: { score: 'number' },
    })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })
})
