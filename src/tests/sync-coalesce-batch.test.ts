import { describe, expect, test } from 'vitest'
import { coalesceBatch } from '../main/services/sync-agent'

// Pure-function tests for the drain coalescing helper. Multiple outbox
// entries for the same (table, row_id, op) collapse to the latest only
// — saves redundant gateway round-trips during edit-heavy sessions.

function entry(
  id: number,
  table: string,
  rowId: string,
  op: 'insert' | 'update' | 'delete',
): Parameters<typeof coalesceBatch>[0][number] {
  return {
    id,
    user_id: 'u1',
    device_id: 'd1',
    table_name: table,
    row_id: rowId,
    op,
    payload: '{}',
    lamport: String(id),
    attempts: 0,
  }
}

describe('coalesceBatch', () => {
  test('keeps single entry unchanged', () => {
    const { kept, coalesced } = coalesceBatch([entry(1, 'notes', 'n1', 'update')])
    expect(kept).toHaveLength(1)
    expect(kept[0]?.id).toBe(1)
    expect(coalesced).toHaveLength(0)
  })

  test('coalesces 3 updates to the same row → keeps the latest', () => {
    const { kept, coalesced } = coalesceBatch([
      entry(1, 'notes', 'n1', 'update'),
      entry(2, 'notes', 'n1', 'update'),
      entry(3, 'notes', 'n1', 'update'),
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0]?.id).toBe(3) // the latest
    expect(coalesced.map((e) => e.id).sort()).toEqual([1, 2])
  })

  test('does NOT coalesce across different ops', () => {
    // insert and delete for the same row are both meaningful events.
    const { kept, coalesced } = coalesceBatch([
      entry(1, 'notes', 'n1', 'insert'),
      entry(2, 'notes', 'n1', 'delete'),
    ])
    expect(kept).toHaveLength(2)
    expect(coalesced).toHaveLength(0)
  })

  test('does NOT coalesce across different rows', () => {
    const { kept } = coalesceBatch([
      entry(1, 'notes', 'n1', 'update'),
      entry(2, 'notes', 'n2', 'update'),
    ])
    expect(kept).toHaveLength(2)
  })

  test('kept entries preserve ascending outbox-id order', () => {
    const { kept } = coalesceBatch([
      entry(10, 'notes', 'n1', 'update'),
      entry(20, 'notes', 'n2', 'update'),
      entry(30, 'notes', 'n3', 'update'),
    ])
    expect(kept.map((e) => e.id)).toEqual([10, 20, 30])
  })

  test('mixed batch: coalesces same-op duplicates, preserves distinct rows', () => {
    const { kept, coalesced } = coalesceBatch([
      entry(1, 'notes', 'n1', 'update'),
      entry(2, 'notes', 'n2', 'insert'),
      entry(3, 'notes', 'n1', 'update'), // coalesces with id=1
      entry(4, 'meetings', 'm1', 'update'),
      entry(5, 'notes', 'n2', 'insert'), // coalesces with id=2
    ])
    const keptIds = kept.map((e) => e.id).sort((a, b) => a - b)
    const coalIds = coalesced.map((e) => e.id).sort((a, b) => a - b)
    expect(keptIds).toEqual([3, 4, 5]) // latest of n1-update, only m1, latest of n2-insert
    expect(coalIds).toEqual([1, 2])
  })
})
