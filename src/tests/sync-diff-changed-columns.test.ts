import { describe, expect, test } from 'vitest'
import { diffChangedColumns } from '@cyggie/db/sqlite/repositories/_sync'

// Pure-function tests for the column-diff primitive shared by T38 large-column
// trimming and field-LWW field_lamports computation. Returns the keys whose
// value changed between a before-row and an after-row.

describe('diffChangedColumns', () => {
  test('detects a changed scalar', () => {
    expect(
      diffChangedColumns({ id: 'c1', arr: 100 }, { id: 'c1', arr: 200 }),
    ).toEqual(['arr'])
  })

  test('ignores unchanged scalars (fast-path, no allocation)', () => {
    expect(
      diffChangedColumns(
        { id: 'c1', arr: 100, name: 'Acme' },
        { id: 'c1', arr: 100, name: 'Acme' },
      ),
    ).toEqual([])
  })

  test('deep-compares object/array columns by value', () => {
    const before = { id: 'c1', tags: ['a', 'b'] }
    const afterSame = { id: 'c1', tags: ['a', 'b'] } // different ref, same value
    expect(diffChangedColumns(before, afterSame)).toEqual([])
    const afterDiff = { id: 'c1', tags: ['a', 'c'] }
    expect(diffChangedColumns(before, afterDiff)).toEqual(['tags'])
  })

  test('null vs value counts as changed', () => {
    expect(
      diffChangedColumns({ id: 'c1', domain: null }, { id: 'c1', domain: 'x.com' }),
    ).toEqual(['domain'])
  })

  test('a key missing on either side is treated as changed', () => {
    expect(diffChangedColumns({ id: 'c1' }, { id: 'c1', stage: 'seed' })).toEqual([
      'stage',
    ])
    expect(diffChangedColumns({ id: 'c1', stage: 'seed' }, { id: 'c1' })).toEqual([
      'stage',
    ])
  })

  test('returns only the changed subset across many columns', () => {
    const before = { id: 'c1', a: 1, b: 2, c: 3, d: { x: 1 } }
    const after = { id: 'c1', a: 1, b: 9, c: 3, d: { x: 2 } }
    expect(diffChangedColumns(before, after).sort()).toEqual(['b', 'd'])
  })
})
