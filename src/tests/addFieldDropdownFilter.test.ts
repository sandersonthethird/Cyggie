import { describe, it, expect } from 'vitest'
import { filterAndGroupFields } from '../renderer/components/crm/AddFieldDropdown'
import type { HardcodedFieldDef } from '../renderer/constants/contactFields'
import type { CustomFieldWithValue } from '../shared/types/custom-fields'

const SECTIONS = [
  { key: 'contact_info', label: 'Contact Info' },
  { key: 'professional', label: 'Professional' },
  { key: 'relationship', label: 'Relationship' },
]

const HARDCODED: HardcodedFieldDef[] = [
  { key: 'phone', label: 'Phone', defaultSection: 'contact_info' },
  { key: 'city', label: 'City', defaultSection: 'contact_info' },
  { key: 'university', label: 'University', defaultSection: 'professional' },
  { key: 'notes', label: 'Notes', defaultSection: 'relationship' },
]

function makeCustomField(
  id: string,
  label: string,
  section: string,
  value: unknown = null,
): CustomFieldWithValue {
  return {
    id,
    label,
    fieldType: 'text',
    section,
    entityType: 'contact',
    optionsJson: null,
    value,
    createdAt: '',
  }
}

// ── Section grouping ──────────────────────────────────────────────────────────

describe('filterAndGroupFields — section grouping', () => {
  it('groups hardcoded fields by defaultSection', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], {}, {}, SECTIONS, '')
    const keys = result.map((g) => g.sectionKey)
    expect(keys).toContain('contact_info')
    expect(keys).toContain('professional')
    expect(keys).toContain('relationship')
  })

  it('omits sections with no fields', () => {
    const noRelationshipFields: HardcodedFieldDef[] = [
      { key: 'phone', label: 'Phone', defaultSection: 'contact_info' },
    ]
    const result = filterAndGroupFields(noRelationshipFields, [], [], {}, {}, SECTIONS, '')
    const keys = result.map((g) => g.sectionKey)
    expect(keys).not.toContain('relationship')
    expect(keys).toContain('contact_info')
  })

  it('respects fieldPlacements override over defaultSection', () => {
    const placements = { phone: 'professional' }
    const result = filterAndGroupFields(HARDCODED, [], [], {}, placements, SECTIONS, '')
    const professional = result.find((g) => g.sectionKey === 'professional')!
    expect(professional.items.map((i) => i.key)).toContain('phone')
    // contact_info should no longer have phone
    const contactInfo = result.find((g) => g.sectionKey === 'contact_info')
    expect(contactInfo?.items.map((i) => i.key)).not.toContain('phone')
  })

  it('includes custom fields in the group matching their section', () => {
    const custom = [makeCustomField('abc', 'Deal Stage', 'professional')]
    const result = filterAndGroupFields([], custom, [], {}, {}, SECTIONS, '')
    const professional = result.find((g) => g.sectionKey === 'professional')!
    expect(professional.items.map((i) => i.key)).toContain('custom:abc')
  })
})

// ── checked / disabled state ──────────────────────────────────────────────────

describe('filterAndGroupFields — checked and disabled state', () => {
  it('marks field as checked and disabled when entityData has a value', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], { phone: '555' }, {}, SECTIONS, '')
    const contactInfo = result.find((g) => g.sectionKey === 'contact_info')!
    const phoneItem = contactInfo.items.find((i) => i.key === 'phone')!
    expect(phoneItem.checked).toBe(true)
    expect(phoneItem.disabled).toBe(true)
  })

  it('marks field as checked but NOT disabled when in addedFields (no value)', () => {
    const result = filterAndGroupFields(HARDCODED, [], ['phone'], {}, {}, SECTIONS, '')
    const contactInfo = result.find((g) => g.sectionKey === 'contact_info')!
    const phoneItem = contactInfo.items.find((i) => i.key === 'phone')!
    expect(phoneItem.checked).toBe(true)
    expect(phoneItem.disabled).toBe(false)
  })

  it('marks field as unchecked and not disabled when not added and no value', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], {}, {}, SECTIONS, '')
    const contactInfo = result.find((g) => g.sectionKey === 'contact_info')!
    const phoneItem = contactInfo.items.find((i) => i.key === 'phone')!
    expect(phoneItem.checked).toBe(false)
    expect(phoneItem.disabled).toBe(false)
  })

  it('marks custom field checked and disabled when it has a value', () => {
    const custom = [makeCustomField('abc', 'Deal Stage', 'professional', 'Series A')]
    const result = filterAndGroupFields([], custom, [], {}, {}, SECTIONS, '')
    const professional = result.find((g) => g.sectionKey === 'professional')!
    const item = professional.items.find((i) => i.key === 'custom:abc')!
    expect(item.checked).toBe(true)
    expect(item.disabled).toBe(true)
  })
})

// ── search filtering ──────────────────────────────────────────────────────────

describe('filterAndGroupFields — search filtering', () => {
  it('returns a single __search__ group in search mode', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], {}, {}, SECTIONS, 'ph')
    expect(result).toHaveLength(1)
    expect(result[0].sectionKey).toBe('__search__')
    expect(result[0].sectionLabel).toBe('Results')
  })

  it('filters items by label (case-insensitive)', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], {}, {}, SECTIONS, 'PHONE')
    expect(result[0].items).toHaveLength(1)
    expect(result[0].items[0].key).toBe('phone')
  })

  it('returns empty results group when no items match the query', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], {}, {}, SECTIONS, 'zzzzz')
    expect(result[0].items).toHaveLength(0)
  })

  it('returns grouped results (not search mode) when query is empty', () => {
    const result = filterAndGroupFields(HARDCODED, [], [], {}, {}, SECTIONS, '')
    expect(result.every((g) => g.sectionKey !== '__search__')).toBe(true)
  })

  it('search matches custom field labels too', () => {
    const custom = [makeCustomField('abc', 'Deal Stage', 'professional')]
    const result = filterAndGroupFields(HARDCODED, custom, [], {}, {}, SECTIONS, 'deal')
    expect(result[0].items.map((i) => i.key)).toContain('custom:abc')
  })
})
