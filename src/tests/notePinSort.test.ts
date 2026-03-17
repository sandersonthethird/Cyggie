/**
 * Tests for sortByPin — pure TS, no DB or IPC dependencies.
 */
import { describe, it, expect } from 'vitest'
import { sortByPin } from '../renderer/hooks/usePinToggle'

type Note = { id: string; isPinned: boolean; updatedAt: string }

function note(id: string, isPinned: boolean, updatedAt: string): Note {
  return { id, isPinned, updatedAt }
}

describe('sortByPin', () => {
  it('pinned note appears before unpinned regardless of date', () => {
    const result = sortByPin([
      note('old-pinned', true, '2026-01-01T00:00:00Z'),
      note('new-unpinned', false, '2026-03-01T00:00:00Z'),
    ])
    expect(result[0]!.id).toBe('old-pinned')
  })

  it('multiple pinned notes ordered by updatedAt DESC', () => {
    const result = sortByPin([
      note('p1', true, '2026-01-01T00:00:00Z'),
      note('p2', true, '2026-03-01T00:00:00Z'),
      note('p3', true, '2026-02-01T00:00:00Z'),
    ])
    expect(result.map((n) => n.id)).toEqual(['p2', 'p3', 'p1'])
  })

  it('multiple unpinned notes ordered by updatedAt DESC', () => {
    const result = sortByPin([
      note('u1', false, '2026-01-01T00:00:00Z'),
      note('u2', false, '2026-03-01T00:00:00Z'),
      note('u3', false, '2026-02-01T00:00:00Z'),
    ])
    expect(result.map((n) => n.id)).toEqual(['u2', 'u3', 'u1'])
  })

  it('empty array returns empty array', () => {
    expect(sortByPin([])).toEqual([])
  })

  it('all-pinned array sorted by updatedAt DESC', () => {
    const result = sortByPin([
      note('a', true, '2026-01-01T00:00:00Z'),
      note('b', true, '2026-04-01T00:00:00Z'),
      note('c', true, '2026-02-01T00:00:00Z'),
    ])
    expect(result.map((n) => n.id)).toEqual(['b', 'c', 'a'])
  })
})
