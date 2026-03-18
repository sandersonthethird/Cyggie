import { describe, it, expect } from 'vitest'
import { computeWithinSectionReorder } from '../renderer/hooks/useCustomFieldSection'

type Field = { id: string; section: string | null }

function fields(...ids: string[]): Field[] {
  return ids.map((id) => ({ id, section: 'test' }))
}

describe('computeWithinSectionReorder', () => {
  it('returns null for self-drop (no-op)', () => {
    expect(computeWithinSectionReorder(fields('A', 'B', 'C'), 'A', 'A')).toBeNull()
  })

  it('returns null when dragging id is not in fields', () => {
    expect(computeWithinSectionReorder(fields('A', 'B'), 'X', 'A')).toBeNull()
  })

  it('returns null when target id is not in fields', () => {
    expect(computeWithinSectionReorder(fields('A', 'B'), 'A', 'X')).toBeNull()
  })

  it('moves first field to last position', () => {
    // drag A to just before C → [B, A, C] because A is inserted before C
    // drag A, target C: withoutDrag=[B,C], targetIdx=1 (C), result=[B,A,C]
    const result = computeWithinSectionReorder(fields('A', 'B', 'C'), 'A', 'C')
    expect(result?.map((f) => f.id)).toEqual(['B', 'A', 'C'])
  })

  it('moves last field to first position', () => {
    // drag C, target A: withoutDrag=[A,B], targetIdx=0 (A), result=[C,A,B]
    const result = computeWithinSectionReorder(fields('A', 'B', 'C'), 'C', 'A')
    expect(result?.map((f) => f.id)).toEqual(['C', 'A', 'B'])
  })

  it('moves middle field to first position', () => {
    // drag B, target A: withoutDrag=[A,C], targetIdx=0, result=[B,A,C]
    const result = computeWithinSectionReorder(fields('A', 'B', 'C'), 'B', 'A')
    expect(result?.map((f) => f.id)).toEqual(['B', 'A', 'C'])
  })

  it('produces ordered IDs matching expected section reorder (plan example: A,B,C drag A→C gives B,A,C)', () => {
    const input = fields('A', 'B', 'C')
    const result = computeWithinSectionReorder(input, 'A', 'C')
    expect(result?.map((f) => f.id)).toEqual(['B', 'A', 'C'])
  })

  it('does not mutate the original array', () => {
    const input = fields('A', 'B', 'C')
    computeWithinSectionReorder(input, 'C', 'A')
    expect(input.map((f) => f.id)).toEqual(['A', 'B', 'C'])
  })

  it('handles two-element section', () => {
    const result = computeWithinSectionReorder(fields('A', 'B'), 'B', 'A')
    expect(result?.map((f) => f.id)).toEqual(['B', 'A'])
  })
})
