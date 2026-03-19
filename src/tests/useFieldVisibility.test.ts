import { describe, it, expect } from 'vitest'
import {
  computeShowField,
  computeGetFieldSection,
  computeCleanupOnDone,
} from '../renderer/hooks/useFieldVisibility'
import type { HardcodedFieldDef } from '../renderer/constants/contactFields'

// ── computeShowField ──────────────────────────────────────────────────────────

describe('computeShowField', () => {
  const noHidden: string[] = []
  const noAdded: string[] = []

  it('returns false when key is in hiddenFields (hidden wins over value)', () => {
    expect(computeShowField('phone', '555-1234', ['phone'], noAdded, false, false)).toBe(false)
  })

  it('returns true when value is present and key is not hidden', () => {
    expect(computeShowField('phone', '555-1234', noHidden, noAdded, false, false)).toBe(true)
  })

  it('returns true when isEditing and key is in addedFields (value absent)', () => {
    expect(computeShowField('phone', null, noHidden, ['phone'], true, false)).toBe(true)
  })

  it('returns true when showAllFields and key is in addedFields (value absent)', () => {
    expect(computeShowField('phone', null, noHidden, ['phone'], false, true)).toBe(true)
  })

  it('returns true when showAllFields even if key is not in addedFields', () => {
    expect(computeShowField('phone', null, noHidden, noAdded, false, true)).toBe(true)
  })

  it('returns false when no value, not editing, not showAll, not in addedFields', () => {
    expect(computeShowField('phone', null, noHidden, noAdded, false, false)).toBe(false)
  })

  it('returns false for empty string value (treated as no value)', () => {
    expect(computeShowField('phone', '', noHidden, noAdded, false, false)).toBe(false)
  })

  it('returns false for undefined value when not editing and not in addedFields', () => {
    expect(computeShowField('phone', undefined, noHidden, noAdded, false, false)).toBe(false)
  })

  it('hidden field with showAllFields still returns false', () => {
    expect(computeShowField('phone', null, ['phone'], noAdded, false, true)).toBe(false)
  })
})

// ── computeGetFieldSection ────────────────────────────────────────────────────

describe('computeGetFieldSection', () => {
  const defs: HardcodedFieldDef[] = [
    { key: 'phone', label: 'Phone', defaultSection: 'contact_info' },
    { key: 'fundSize', label: 'Fund Size', defaultSection: 'investor_info' },
  ]
  const defMap = new Map(defs.map((d) => [d.key, d]))
  const validSections = new Set(['contact_info', 'professional', 'relationship', 'investor_info'])

  it('returns stored placement when it is a valid section', () => {
    const placements = { phone: 'professional' }
    expect(computeGetFieldSection('phone', placements, defMap, validSections, 'contact')).toBe(
      'professional',
    )
  })

  it('falls back to defaultSection when stored placement is invalid', () => {
    const placements = { phone: 'nonexistent_section' }
    expect(computeGetFieldSection('phone', placements, defMap, validSections, 'contact')).toBe(
      'contact_info',
    )
  })

  it('uses defaultSection when no placement is stored', () => {
    expect(computeGetFieldSection('phone', {}, defMap, validSections, 'contact')).toBe(
      'contact_info',
    )
  })

  it('falls back to contact_info for unknown contact field with no placement', () => {
    expect(computeGetFieldSection('unknownKey', {}, defMap, validSections, 'contact')).toBe(
      'contact_info',
    )
  })

  it('falls back to overview for unknown company field with no placement', () => {
    const companyValidSections = new Set(['overview', 'pipeline', 'financials'])
    expect(
      computeGetFieldSection('unknownKey', {}, defMap, companyValidSections, 'company'),
    ).toBe('overview')
  })

  it('uses stored placement for investor_info field', () => {
    const placements = { fundSize: 'investor_info' }
    expect(computeGetFieldSection('fundSize', placements, defMap, validSections, 'contact')).toBe(
      'investor_info',
    )
  })
})

// ── computeCleanupOnDone ──────────────────────────────────────────────────────

describe('computeCleanupOnDone', () => {
  it('returns same array when emptyKeys is empty', () => {
    expect(computeCleanupOnDone(['phone', 'city'], [])).toEqual(['phone', 'city'])
  })

  it('removes specified empty keys from addedFields', () => {
    expect(computeCleanupOnDone(['phone', 'city', 'custom:123'], ['phone', 'custom:123'])).toEqual([
      'city',
    ])
  })

  it('returns empty array when all addedFields are empty', () => {
    expect(computeCleanupOnDone(['phone', 'city'], ['phone', 'city'])).toEqual([])
  })

  it('no-ops when emptyKeys are not in addedFields', () => {
    expect(computeCleanupOnDone(['phone'], ['city'])).toEqual(['phone'])
  })

  it('does not mutate the original addedFields array', () => {
    const original = ['phone', 'city']
    computeCleanupOnDone(original, ['phone'])
    expect(original).toEqual(['phone', 'city'])
  })
})
