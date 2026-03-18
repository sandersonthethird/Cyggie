import { describe, it, expect } from 'vitest'
import { computeChipDelta } from '../renderer/utils/chip-delta'

describe('computeChipDelta', () => {
  it('adds chipId when dropped onto summary section', () => {
    const result = computeChipDelta('professional', 'summary', 'custom:abc', ['custom:xyz'])
    expect(result).toEqual(['custom:xyz', 'custom:abc'])
  })

  it('removes chipId when dragged out of summary section', () => {
    const result = computeChipDelta('summary', 'professional', 'custom:abc', ['custom:xyz', 'custom:abc'])
    expect(result).toEqual(['custom:xyz'])
  })

  it('leaves pinnedKeys unchanged for moves between non-summary sections', () => {
    const keys = ['custom:xyz']
    const result = computeChipDelta('professional', 'relationship', 'custom:abc', keys)
    expect(result).toBe(keys) // same reference — no allocation
  })

  it('is idempotent when adding a key already in pinnedKeys', () => {
    const keys = ['custom:abc']
    const result = computeChipDelta('professional', 'summary', 'custom:abc', keys)
    expect(result).toBe(keys) // same reference returned
  })

  it('is idempotent when removing a key not in pinnedKeys', () => {
    const keys = ['custom:xyz']
    const result = computeChipDelta('summary', 'professional', 'custom:abc', keys)
    expect(result).toEqual(['custom:xyz'])
  })

  it('handles drop from null (unsectioned) onto summary', () => {
    const result = computeChipDelta(null, 'summary', 'custom:new', [])
    expect(result).toEqual(['custom:new'])
  })
})
