// @vitest-environment jsdom
/**
 * Tests for useTableFilters hook.
 *
 * Uses @testing-library/react renderHook + a test ColumnDef set that covers
 * all three filter types: select, number/date (range), and text.
 *
 * Data flow under test:
 *   URL searchParams ──► columnFilters  (select: ?field=value)
 *                   ──► rangeFilters   (range:  ?field_min=X & ?field_max=X)
 *                   ──► textFilters    (text:   ?field_q=search)
 *
 *   handlers ──► setSearchParams ──► URL ──► re-render with updated state
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTableFilters } from '../renderer/hooks/useTableFilters'
import type { ColumnDef } from '../renderer/components/crm/tableUtils'

// ── Test fixtures ──────────────────────────────────────────────────────────────

const TEST_COLS: ColumnDef[] = [
  { key: 'type', label: 'Type', field: 'entityType', defaultVisible: true, width: 100, minWidth: 80, sortable: true, editable: true, type: 'select', options: [{ value: 'prospect', label: 'Prospect' }, { value: 'pass', label: 'Pass' }] },
  { key: 'raiseSize', label: 'Raise', field: 'raiseSize', defaultVisible: true, width: 100, minWidth: 60, sortable: true, editable: true, type: 'number' },
  { key: 'sector', label: 'Sector', field: 'sector', defaultVisible: true, width: 140, minWidth: 80, sortable: true, editable: true, type: 'text' },
]

// Maps entityType → 'type' in URL (simulates Companies.tsx FIELD_TO_PARAM)
const FIELD_TO_PARAM: Record<string, string> = { entityType: 'type' }

function makeParams(init: Record<string, string | string[]> = {}): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(init)) {
    if (Array.isArray(v)) v.forEach((val) => p.append(k, val))
    else p.set(k, v)
  }
  return p
}

// ── columnFilters ──────────────────────────────────────────────────────────────

describe('useTableFilters — columnFilters', () => {
  it('derives select filter from URL param (with fieldToParamMap)', () => {
    const { result } = renderHook(() =>
      useTableFilters({
        columnDefs: TEST_COLS,
        searchParams: makeParams({ type: 'prospect' }),
        setSearchParams: vi.fn(),
        fieldToParamMap: FIELD_TO_PARAM
      })
    )
    expect(result.current.columnFilters).toEqual({ entityType: ['prospect'] })
  })

  it('returns empty columnFilters when no select params present', () => {
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: makeParams(), setSearchParams: vi.fn() })
    )
    expect(result.current.columnFilters).toEqual({})
  })
})

// ── rangeFilters ───────────────────────────────────────────────────────────────

describe('useTableFilters — rangeFilters', () => {
  it('derives range filter from _min/_max URL params', () => {
    const { result } = renderHook(() =>
      useTableFilters({
        columnDefs: TEST_COLS,
        searchParams: makeParams({ raiseSize_min: '5', raiseSize_max: '20' }),
        setSearchParams: vi.fn()
      })
    )
    expect(result.current.rangeFilters).toEqual({ raiseSize: { min: '5', max: '20' } })
  })

  it('returns empty rangeFilters when no range params present', () => {
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: makeParams(), setSearchParams: vi.fn() })
    )
    expect(result.current.rangeFilters).toEqual({})
  })
})

// ── textFilters ────────────────────────────────────────────────────────────────

describe('useTableFilters — textFilters', () => {
  it('derives text filter from _q URL param', () => {
    const { result } = renderHook(() =>
      useTableFilters({
        columnDefs: TEST_COLS,
        searchParams: makeParams({ sector_q: 'fintech' }),
        setSearchParams: vi.fn()
      })
    )
    expect(result.current.textFilters).toEqual({ sector: 'fintech' })
  })
})

// ── activeFilterCount ──────────────────────────────────────────────────────────

describe('useTableFilters — activeFilterCount', () => {
  it('counts all active filter values across all types', () => {
    const { result } = renderHook(() =>
      useTableFilters({
        columnDefs: TEST_COLS,
        searchParams: makeParams({ type: ['prospect', 'pass'], raiseSize_min: '5', sector_q: 'fin' }),
        setSearchParams: vi.fn(),
        fieldToParamMap: FIELD_TO_PARAM
      })
    )
    // 2 select + 1 range + 1 text = 4
    expect(result.current.activeFilterCount).toBe(4)
  })
})

// ── handlers ───────────────────────────────────────────────────────────────────

describe('useTableFilters — handleRangeFilter', () => {
  it('sets _min and _max URL params', () => {
    let params = makeParams()
    const setSearchParams = vi.fn((updater: (prev: URLSearchParams) => URLSearchParams) => {
      params = updater(params)
    })
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: params, setSearchParams })
    )
    act(() => { result.current.handleRangeFilter('raiseSize', { min: '10', max: '50' }) })
    expect(params.get('raiseSize_min')).toBe('10')
    expect(params.get('raiseSize_max')).toBe('50')
  })
})

describe('useTableFilters — handleTextFilter', () => {
  it('sets _q URL param for non-empty value', () => {
    let params = makeParams()
    const setSearchParams = vi.fn((updater: (prev: URLSearchParams) => URLSearchParams) => {
      params = updater(params)
    })
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: params, setSearchParams })
    )
    act(() => { result.current.handleTextFilter('sector', 'biotech') })
    expect(params.get('sector_q')).toBe('biotech')
  })

  it('removes _q URL param for empty string', () => {
    let params = makeParams({ sector_q: 'biotech' })
    const setSearchParams = vi.fn((updater: (prev: URLSearchParams) => URLSearchParams) => {
      params = updater(params)
    })
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: params, setSearchParams })
    )
    act(() => { result.current.handleTextFilter('sector', '') })
    expect(params.has('sector_q')).toBe(false)
  })
})

describe('useTableFilters — clearAllFilters', () => {
  it('removes all filter params for columns in columnDefs', () => {
    let params = makeParams({ type: 'prospect', raiseSize_min: '5', sector_q: 'fin' })
    const setSearchParams = vi.fn((updater: (prev: URLSearchParams) => URLSearchParams) => {
      params = updater(params)
    })
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: params, setSearchParams, fieldToParamMap: FIELD_TO_PARAM })
    )
    act(() => { result.current.clearAllFilters() })
    expect(params.has('type')).toBe(false)
    expect(params.has('raiseSize_min')).toBe(false)
    expect(params.has('sector_q')).toBe(false)
  })
})

describe('useTableFilters — fieldToParamMap', () => {
  it('paramForField maps field name to URL param name', () => {
    const { result } = renderHook(() =>
      useTableFilters({ columnDefs: TEST_COLS, searchParams: makeParams(), setSearchParams: vi.fn(), fieldToParamMap: FIELD_TO_PARAM })
    )
    expect(result.current.paramForField('entityType')).toBe('type')
    expect(result.current.paramForField('sector')).toBe('sector')
  })
})
