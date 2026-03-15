// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createColumnConfigLoader,
  saveColumnConfig,
  sortRows,
  chunkArray,
  executeBulkEdit
} from '../renderer/components/crm/tableUtils'
import type { ColumnDef, SortState } from '../renderer/components/crm/tableUtils'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DEFS: ColumnDef[] = [
  { key: 'name',   label: 'Name',   field: 'name',   defaultVisible: true,  width: 200, minWidth: 80, sortable: true,  editable: false, type: 'computed' },
  { key: 'type',   label: 'Type',   field: 'type',   defaultVisible: true,  width: 120, minWidth: 80, sortable: true,  editable: true,  type: 'select' },
  { key: 'score',  label: 'Score',  field: 'score',  defaultVisible: false, width: 80,  minWidth: 60, sortable: true,  editable: true,  type: 'number' },
  { key: 'hidden', label: 'Hidden', field: 'hidden', defaultVisible: false, width: 80,  minWidth: 60, sortable: false, editable: true,  type: 'text' }
]

// ─── createColumnConfigLoader ─────────────────────────────────────────────────

describe('createColumnConfigLoader', () => {
  const KEY = 'test:columns'

  beforeEach(() => {
    localStorage.clear()
  })

  it('returns default visible keys when localStorage is empty', () => {
    const load = createColumnConfigLoader(KEY, DEFS)
    expect(load()).toEqual(['name', 'type'])
  })

  it('returns stored keys filtered to valid defs', () => {
    // Include all defaultVisible keys so nothing new gets appended
    localStorage.setItem(KEY, JSON.stringify(['name', 'type', 'score']))
    const load = createColumnConfigLoader(KEY, DEFS)
    expect(load()).toEqual(['name', 'type', 'score'])
  })

  it('drops unknown keys from stored config', () => {
    localStorage.setItem(KEY, JSON.stringify(['name', 'type', 'nonexistent', 'score']))
    const load = createColumnConfigLoader(KEY, DEFS)
    expect(load()).toEqual(['name', 'type', 'score'])
  })

  it('appends newly-added default-visible keys not in stored config', () => {
    // stored config predates 'name' becoming defaultVisible
    localStorage.setItem(KEY, JSON.stringify(['type']))
    const load = createColumnConfigLoader(KEY, DEFS)
    // 'name' is defaultVisible and not in stored → appended
    expect(load()).toEqual(['type', 'name'])
  })

  it('falls back to defaults on JSON parse error', () => {
    localStorage.setItem(KEY, '{invalid json}')
    const load = createColumnConfigLoader(KEY, DEFS)
    expect(load()).toEqual(['name', 'type'])
  })
})

// ─── saveColumnConfig ─────────────────────────────────────────────────────────

describe('saveColumnConfig', () => {
  const KEY = 'test:save'

  beforeEach(() => {
    localStorage.clear()
  })

  it('writes visible keys to localStorage', () => {
    saveColumnConfig(KEY, ['name', 'score'])
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['name', 'score'])
  })
})

// ─── sortRows ─────────────────────────────────────────────────────────────────

describe('sortRows', () => {
  const rows = [
    { name: 'Zeta', score: 10 },
    { name: 'Alpha', score: 30 },
    { name: null,   score: 20 }
  ]

  it('sorts strings ascending', () => {
    const sort: SortState = { key: 'name', dir: 'asc' }
    const result = sortRows(rows, sort, DEFS)
    expect(result.map((r) => r.name)).toEqual(['Alpha', 'Zeta', null])
  })

  it('sorts strings descending', () => {
    const sort: SortState = { key: 'name', dir: 'desc' }
    const result = sortRows(rows, sort, DEFS)
    expect(result.map((r) => r.name)).toEqual(['Zeta', 'Alpha', null])
  })

  it('sorts numbers ascending, nulls last', () => {
    const sort: SortState = { key: 'score', dir: 'asc' }
    const result = sortRows(rows, sort, DEFS)
    expect(result.map((r) => r.score)).toEqual([10, 20, 30])
  })

  it('returns original array unchanged when key not found', () => {
    const sort: SortState = { key: 'nonexistent', dir: 'asc' }
    const result = sortRows(rows, sort, DEFS)
    expect(result).toEqual(rows)
  })
})

// ─── chunkArray ───────────────────────────────────────────────────────────────

describe('chunkArray', () => {
  it('splits evenly into chunks of given size', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })

  it('last chunk is smaller when array does not divide evenly', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns single chunk when size >= array length', () => {
    expect(chunkArray([1, 2, 3], 10)).toEqual([[1, 2, 3]])
  })

  it('returns empty array for empty input', () => {
    expect(chunkArray([], 5)).toEqual([])
  })
})

// ─── executeBulkEdit ─────────────────────────────────────────────────────────

describe('executeBulkEdit', () => {
  it('returns empty failedIds when all updates succeed', async () => {
    const updateFn = vi.fn().mockResolvedValue(undefined)
    const onPatch = vi.fn()
    const result = await executeBulkEdit({
      ids: ['a', 'b', 'c'],
      getOriginalValue: (id) => `orig-${id}`,
      updateFn,
      onPatch
    })
    expect(result.failedIds).toEqual([])
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('returns failed ids and reverts only those rows on partial failure', async () => {
    const updateFn = vi.fn()
      .mockResolvedValueOnce(undefined)   // id-1 succeeds
      .mockRejectedValueOnce(new Error()) // id-2 fails
      .mockResolvedValueOnce(undefined)   // id-3 succeeds
    const patches: Record<string, unknown> = {}
    const result = await executeBulkEdit({
      ids: ['id-1', 'id-2', 'id-3'],
      getOriginalValue: (id) => `orig-${id}`,
      updateFn,
      onPatch: (id, val) => { patches[id] = val }
    })
    expect(result.failedIds).toEqual(['id-2'])
    expect(patches['id-2']).toBe('orig-id-2')
    expect(patches['id-1']).toBeUndefined()
    expect(patches['id-3']).toBeUndefined()
  })

  it('processes ids in chunks of chunkSize', async () => {
    const callOrder: string[] = []
    // 5 ids with chunkSize=2 → chunks [a,b], [c,d], [e]
    // chunk [a,b] resolves before [c,d] starts
    const updateFn = vi.fn().mockImplementation((id: string) => {
      callOrder.push(id)
      return Promise.resolve()
    })
    await executeBulkEdit({
      ids: ['a', 'b', 'c', 'd', 'e'],
      getOriginalValue: () => null,
      updateFn,
      onPatch: vi.fn(),
      chunkSize: 2
    })
    // All 5 called, in order
    expect(callOrder).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(updateFn).toHaveBeenCalledTimes(5)
  })
})
