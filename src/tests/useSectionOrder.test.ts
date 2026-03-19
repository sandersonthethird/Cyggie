import { describe, it, expect } from 'vitest'
import { reorderSections } from '../renderer/hooks/useSectionOrder'
import { computeEffectiveOrder } from '../renderer/hooks/useHeaderChipOrder'

// ── reorderSections ───────────────────────────────────────────────────────────
//
// State machine:
//   ['a','b','c','d']  drag 'a' → before 'c'  →  ['b','a','c','d']
//   ['a','b','c','d']  drag 'd' → before 'b'  →  ['a','d','b','c']
//   ['a','b','c']      drag 'a' → 'a' (self)  →  null
//   ['a','b','c']      drag 'a' → 'x' (stale) →  null
//

describe('reorderSections', () => {
  it('returns null for self-drop (no-op)', () => {
    expect(reorderSections(['a', 'b', 'c'], 'a', 'a')).toBeNull()
  })

  it('returns null when toKey is not in orderedSections', () => {
    expect(reorderSections(['a', 'b', 'c'], 'a', 'x')).toBeNull()
  })

  it('moves first section to before third', () => {
    expect(reorderSections(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('moves last section to before second', () => {
    expect(reorderSections(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('moves middle section to first position', () => {
    expect(reorderSections(['a', 'b', 'c'], 'b', 'a')).toEqual(['b', 'a', 'c'])
  })

  it('does not mutate the original array', () => {
    const original = ['a', 'b', 'c']
    reorderSections(original, 'c', 'a')
    expect(original).toEqual(['a', 'b', 'c'])
  })

  it('handles two-section array', () => {
    expect(reorderSections(['a', 'b'], 'b', 'a')).toEqual(['b', 'a'])
  })
})

// ── computeEffectiveOrder (reused by useSectionOrder) ────────────────────────
// Verify that the section-ordering use-case (filtering out 'summary') works
// correctly with computeEffectiveOrder from useHeaderChipOrder.

describe('computeEffectiveOrder used by useSectionOrder', () => {
  it('summary section is excluded before calling computeEffectiveOrder', () => {
    const allSectionKeys = ['contact_info', 'professional', 'relationship', 'summary']
    const orderable = allSectionKeys.filter((k) => k !== 'summary')
    const result = computeEffectiveOrder([], orderable)
    expect(result).toEqual(['contact_info', 'professional', 'relationship'])
    expect(result).not.toContain('summary')
  })

  it('stored order is respected for orderable sections', () => {
    const allSectionKeys = ['contact_info', 'professional', 'relationship', 'summary']
    const orderable = allSectionKeys.filter((k) => k !== 'summary')
    const stored = ['relationship', 'professional', 'contact_info']
    expect(computeEffectiveOrder(stored, orderable)).toEqual([
      'relationship',
      'professional',
      'contact_info',
    ])
  })

  it('new sections not in stored order are appended to the end', () => {
    const orderable = ['contact_info', 'professional', 'relationship', 'investor_info']
    const stored = ['professional', 'contact_info']
    expect(computeEffectiveOrder(stored, orderable)).toEqual([
      'professional',
      'contact_info',
      'relationship',
      'investor_info',
    ])
  })

  it('stale stored section keys are filtered out', () => {
    const orderable = ['contact_info', 'professional']
    const stored = ['contact_info', 'old_section', 'professional']
    expect(computeEffectiveOrder(stored, orderable)).toEqual(['contact_info', 'professional'])
  })
})
