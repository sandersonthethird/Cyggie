// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildCustomFieldColumnDefs } from '../renderer/components/crm/tableUtils'
import type { CustomFieldDefinition } from '../shared/types/custom-fields'

function makeDef(overrides: Partial<CustomFieldDefinition> = {}): CustomFieldDefinition {
  return {
    id: 'def-1',
    entityType: 'company',
    fieldKey: 'my_field',
    label: 'My Field',
    fieldType: 'text',
    optionsJson: null,
    isRequired: false,
    showInList: false,
    sortOrder: 0,
    ...overrides,
  }
}

describe('buildCustomFieldColumnDefs', () => {
  it('returns empty array for empty input', () => {
    expect(buildCustomFieldColumnDefs([])).toEqual([])
  })

  it('prefixes key with custom:', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ id: 'abc123' })])
    expect(col.key).toBe('custom:abc123')
  })

  it('uses def.label as column label', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ label: 'Focus Area' })])
    expect(col.label).toBe('Focus Area')
  })

  it('sets field to null (not def.fieldKey) for filter-skip safety', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldKey: 'focus_area' })])
    expect(col.field).toBeNull()
  })

  it('sets defaultVisible to false', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef()])
    expect(col.defaultVisible).toBe(false)
  })

  it('sets editable to true', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef()])
    expect(col.editable).toBe(true)
  })

  it('sets sortable to false', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef()])
    expect(col.sortable).toBe(false)
  })

  it('text field → type text, options undefined', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'text' })])
    expect(col.type).toBe('text')
    expect(col.options).toBeUndefined()
  })

  it('number field → type number', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'number' })])
    expect(col.type).toBe('number')
  })

  it('currency field → type number', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'currency' })])
    expect(col.type).toBe('number')
  })

  it('date field → type date', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'date' })])
    expect(col.type).toBe('date')
  })

  it('boolean field → type text', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'boolean' })])
    expect(col.type).toBe('text')
  })

  it('select field with optionsJson → type select, parsed options', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'select', optionsJson: '["B2B","B2C"]' })])
    expect(col.type).toBe('select')
    expect(col.options).toEqual([
      { value: 'B2B', label: 'B2B' },
      { value: 'B2C', label: 'B2C' },
    ])
  })

  it('multiselect field → type select', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'multiselect', optionsJson: '["Yes","No"]' })])
    expect(col.type).toBe('select')
  })

  it('select field with optionsJson null → options undefined', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'select', optionsJson: null })])
    expect(col.options).toBeUndefined()
  })

  it('select field with invalid optionsJson → options undefined (parse guard)', () => {
    const [col] = buildCustomFieldColumnDefs([makeDef({ fieldType: 'select', optionsJson: 'not-json' })])
    expect(col.options).toBeUndefined()
  })

  it('handles multiple defs preserving order', () => {
    const defs = [makeDef({ id: 'a', label: 'Alpha' }), makeDef({ id: 'b', label: 'Beta' })]
    const cols = buildCustomFieldColumnDefs(defs)
    expect(cols).toHaveLength(2)
    expect(cols[0].key).toBe('custom:a')
    expect(cols[1].key).toBe('custom:b')
  })
})
