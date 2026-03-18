import { describe, it, expect } from 'vitest'
import { computeEffectiveOrder, applyReorder } from '../renderer/hooks/useHeaderChipOrder'

describe('computeEffectiveOrder', () => {
  it('returns all chips when stored order is empty', () => {
    expect(computeEffectiveOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('preserves stored order for known chips', () => {
    expect(computeEffectiveOrder(['b', 'a'], ['a', 'b'])).toEqual(['b', 'a'])
  })

  it('filters out stale IDs no longer in allChipIds', () => {
    expect(computeEffectiveOrder(['a', 'x', 'b'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('appends new chips not in stored order to the end', () => {
    expect(computeEffectiveOrder(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('handles partial overlap: filters stale + preserves order + appends new', () => {
    // stored: ['a','b','c'], all: ['b','c','d'] → valid=['b','c'], new=['d']
    expect(computeEffectiveOrder(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c', 'd'])
  })

  it('returns allChipIds in original order when stored is completely stale', () => {
    expect(computeEffectiveOrder(['x', 'y'], ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('applyReorder', () => {
  it('returns null for self-drop (no-op)', () => {
    expect(applyReorder(['a', 'b', 'c'], 'a', 0)).toBeNull()
  })

  it('moves chip to front', () => {
    expect(applyReorder(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })

  it('moves chip to end', () => {
    expect(applyReorder(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
  })

  it('moves chip to middle', () => {
    expect(applyReorder(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('does not mutate the original array', () => {
    const original = ['a', 'b', 'c']
    applyReorder(original, 'c', 0)
    expect(original).toEqual(['a', 'b', 'c'])
  })
})
