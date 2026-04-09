import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runCustomFieldDefinitionsMigration } from '../main/database/migrations/039-custom-field-definitions'
import { runCustomFieldValuesMigration } from '../main/database/migrations/040-custom-field-values'
import { runCustomFieldSectionMigration } from '../main/database/migrations/049-custom-field-section'

// Create a shared in-memory db for this test module.
// We mock the connection module so all repo imports use it.
let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// Import repo functions AFTER mock is set up
const {
  listFieldDefinitions,
  createFieldDefinition,
  updateFieldDefinition,
  deleteFieldDefinition,
  reorderFieldDefinitions,
  setFieldValue,
  deleteFieldValue,
  countFieldValues,
  getFieldValuesForEntity
} = await import('../main/database/repositories/custom-fields.repo')

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`)
  // Stub contacts + org_companies tables for the resolved_label JOIN in getFieldValuesForEntity
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT
    );
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT
    );
  `)
  runCustomFieldDefinitionsMigration(db)
  runCustomFieldValuesMigration(db)
  runCustomFieldSectionMigration(db)
  return db
}

beforeEach(() => {
  testDb = makeTestDb()
})

// ---------------------------------------------------------------------------
// createFieldDefinition
// ---------------------------------------------------------------------------
describe('createFieldDefinition', () => {
  it('creates a definition and returns it', () => {
    const def = createFieldDefinition({
      entityType: 'company',
      fieldKey: 'fund_vintage',
      label: 'Fund Vintage',
      fieldType: 'number',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    })
    expect(def.id).toBeTruthy()
    expect(def.fieldKey).toBe('fund_vintage')
    expect(def.label).toBe('Fund Vintage')
    expect(def.fieldType).toBe('number')
    expect(def.entityType).toBe('company')
    expect(def.isRequired).toBe(false)
    expect(def.showInList).toBe(false)
  })

  it('rejects invalid field_key with uppercase', () => {
    expect(() =>
      createFieldDefinition({
        entityType: 'company',
        fieldKey: 'FundVintage',
        label: 'Fund Vintage',
        fieldType: 'text',
        optionsJson: null,
        isRequired: false,
        showInList: false,
        sortOrder: 0
      })
    ).toThrow(/invalid field_key/i)
  })

  it('rejects field_key with spaces', () => {
    expect(() =>
      createFieldDefinition({
        entityType: 'company',
        fieldKey: 'fund vintage',
        label: 'Fund Vintage',
        fieldType: 'text',
        optionsJson: null,
        isRequired: false,
        showInList: false,
        sortOrder: 0
      })
    ).toThrow(/invalid field_key/i)
  })

  it('rejects field_key with hyphens', () => {
    expect(() =>
      createFieldDefinition({
        entityType: 'company',
        fieldKey: 'fund-vintage',
        label: 'Fund Vintage',
        fieldType: 'text',
        optionsJson: null,
        isRequired: false,
        showInList: false,
        sortOrder: 0
      })
    ).toThrow(/invalid field_key/i)
  })

  it('auto-renames duplicate field_key for same entity_type', () => {
    createFieldDefinition({
      entityType: 'company',
      fieldKey: 'sector',
      label: 'Sector',
      fieldType: 'text',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    })
    const def2 = createFieldDefinition({
      entityType: 'company',
      fieldKey: 'sector',
      label: 'Sector 2',
      fieldType: 'text',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 1
    })
    expect(def2.fieldKey).toBe('sector_2')
  })

  it('allows same field_key for different entity_types', () => {
    const a = createFieldDefinition({
      entityType: 'company',
      fieldKey: 'notes',
      label: 'Notes',
      fieldType: 'textarea',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    })
    const b = createFieldDefinition({
      entityType: 'contact',
      fieldKey: 'notes',
      label: 'Notes',
      fieldType: 'textarea',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    })
    expect(a.entityType).toBe('company')
    expect(b.entityType).toBe('contact')
  })

  it('auto-derives fieldKey from label when not provided', () => {
    const def = createFieldDefinition({ entityType: 'company', label: 'Investment Focus', fieldType: 'text' })
    expect(def.fieldKey).toBe('investment_focus')
  })

  it('resolves collision by appending _2', () => {
    createFieldDefinition({ entityType: 'company', label: 'Investment Focus', fieldType: 'text' })
    const def2 = createFieldDefinition({ entityType: 'company', label: 'Investment Focus', fieldType: 'text' })
    expect(def2.fieldKey).toBe('investment_focus_2')
  })

  it('falls back to "field" when label has no alphanumeric chars', () => {
    const def = createFieldDefinition({ entityType: 'company', label: '!!!', fieldType: 'text' })
    expect(def.fieldKey).toBe('field')
  })
})

// ---------------------------------------------------------------------------
// listFieldDefinitions
// ---------------------------------------------------------------------------
describe('listFieldDefinitions', () => {
  it('returns empty array when no definitions exist', () => {
    expect(listFieldDefinitions('company')).toEqual([])
  })

  it('returns only definitions for the requested entity_type', () => {
    createFieldDefinition({
      entityType: 'company',
      fieldKey: 'field_a',
      label: 'A',
      fieldType: 'text',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    })
    createFieldDefinition({
      entityType: 'contact',
      fieldKey: 'field_b',
      label: 'B',
      fieldType: 'text',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    })
    const companyDefs = listFieldDefinitions('company')
    expect(companyDefs).toHaveLength(1)
    expect(companyDefs[0].fieldKey).toBe('field_a')
  })

  it('returns definitions ordered by sort_order', () => {
    createFieldDefinition({ entityType: 'company', fieldKey: 'z_field', label: 'Z', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 2 })
    createFieldDefinition({ entityType: 'company', fieldKey: 'a_field', label: 'A', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    createFieldDefinition({ entityType: 'company', fieldKey: 'm_field', label: 'M', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 1 })
    const defs = listFieldDefinitions('company')
    expect(defs.map((d) => d.fieldKey)).toEqual(['a_field', 'm_field', 'z_field'])
  })
})

// ---------------------------------------------------------------------------
// updateFieldDefinition
// ---------------------------------------------------------------------------
describe('updateFieldDefinition', () => {
  it('updates label', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'sector', label: 'Sector', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    const updated = updateFieldDefinition(def.id, { label: 'Industry' })
    expect(updated?.label).toBe('Industry')
  })

  it('returns null for unknown id', () => {
    expect(updateFieldDefinition('nonexistent-id', { label: 'X' })).toBeNull()
  })

  it('preserves existing values for unspecified fields', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'sector', label: 'Sector', fieldType: 'select', optionsJson: '["tech","fintech"]', isRequired: true, showInList: true, sortOrder: 5 })
    const updated = updateFieldDefinition(def.id, { label: 'Updated Label' })
    expect(updated?.fieldType).toBe('select')
    expect(updated?.optionsJson).toBe('["tech","fintech"]')
    expect(updated?.isRequired).toBe(true)
    expect(updated?.showInList).toBe(true)
    expect(updated?.sortOrder).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// deleteFieldDefinition + cascade
// ---------------------------------------------------------------------------
describe('deleteFieldDefinition', () => {
  it('returns true when definition existed', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'sector', label: 'Sector', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    expect(deleteFieldDefinition(def.id)).toBe(true)
  })

  it('returns false for unknown id', () => {
    expect(deleteFieldDefinition('nonexistent')).toBe(false)
  })

  it('cascades to delete associated values', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'sector', label: 'Sector', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({
      fieldDefinitionId: def.id,
      entityType: 'company',
      entityId: 'company-123',
      valueText: 'Fintech',
      valueNumber: null,
      valueBoolean: null,
      valueDate: null,
      valueRefId: null
    })
    expect(countFieldValues(def.id)).toBe(1)
    deleteFieldDefinition(def.id)
    // After cascade, the values row should be gone. We can't call countFieldValues
    // because the definition no longer exists; query the values table directly.
    const count = testDb
      .prepare(`SELECT COUNT(*) as count FROM custom_field_values WHERE field_definition_id = ?`)
      .get(def.id) as { count: number }
    expect(count.count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// reorderFieldDefinitions
// ---------------------------------------------------------------------------
describe('reorderFieldDefinitions', () => {
  it('updates sort_order for all provided ids', () => {
    const a = createFieldDefinition({ entityType: 'company', fieldKey: 'field_a', label: 'A', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    const b = createFieldDefinition({ entityType: 'company', fieldKey: 'field_b', label: 'B', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 1 })
    // Reverse order
    reorderFieldDefinitions([b.id, a.id])
    const defs = listFieldDefinitions('company')
    expect(defs[0].fieldKey).toBe('field_b')
    expect(defs[1].fieldKey).toBe('field_a')
  })

  it('does not throw for unknown ids — just warns', () => {
    expect(() => reorderFieldDefinitions(['unknown-id'])).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// setFieldValue + countFieldValues + deleteFieldValue
// ---------------------------------------------------------------------------
describe('setFieldValue / countFieldValues / deleteFieldValue', () => {
  let defId: string

  beforeEach(() => {
    defId = createFieldDefinition({
      entityType: 'company',
      fieldKey: 'arr',
      label: 'ARR',
      fieldType: 'currency',
      optionsJson: null,
      isRequired: false,
      showInList: false,
      sortOrder: 0
    }).id
  })

  it('inserts a value', () => {
    setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: 'co-1', valueText: null, valueNumber: 2_000_000, valueBoolean: null, valueDate: null, valueRefId: null })
    expect(countFieldValues(defId)).toBe(1)
  })

  it('upserts — updating an existing value does not duplicate', () => {
    setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: 'co-1', valueText: null, valueNumber: 1_000_000, valueBoolean: null, valueDate: null, valueRefId: null })
    setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: 'co-1', valueText: null, valueNumber: 2_000_000, valueBoolean: null, valueDate: null, valueRefId: null })
    expect(countFieldValues(defId)).toBe(1)
    // Verify the updated value was stored
    const row = testDb
      .prepare(`SELECT value_number FROM custom_field_values WHERE field_definition_id = ? AND entity_id = ?`)
      .get(defId, 'co-1') as { value_number: number }
    expect(row.value_number).toBe(2_000_000)
  })

  it('counts values across multiple entities', () => {
    setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: 'co-1', valueText: null, valueNumber: 1e6, valueBoolean: null, valueDate: null, valueRefId: null })
    setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: 'co-2', valueText: null, valueNumber: 2e6, valueBoolean: null, valueDate: null, valueRefId: null })
    expect(countFieldValues(defId)).toBe(2)
  })

  it('deleteFieldValue removes the value and returns true', () => {
    setFieldValue({ fieldDefinitionId: defId, entityType: 'company', entityId: 'co-1', valueText: null, valueNumber: 1e6, valueBoolean: null, valueDate: null, valueRefId: null })
    expect(deleteFieldValue(defId, 'co-1')).toBe(true)
    expect(countFieldValues(defId)).toBe(0)
  })

  it('deleteFieldValue returns false when no row matched', () => {
    expect(deleteFieldValue(defId, 'co-nonexistent')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getFieldValuesForEntity
// ---------------------------------------------------------------------------
describe('getFieldValuesForEntity', () => {
  it('returns empty array when no definitions exist', () => {
    expect(getFieldValuesForEntity('company', 'co-1')).toEqual([])
  })

  it('returns definitions with null value for entity with no values set', () => {
    createFieldDefinition({ entityType: 'company', fieldKey: 'sector', label: 'Sector', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    const results = getFieldValuesForEntity('company', 'co-1')
    expect(results).toHaveLength(1)
    expect(results[0].fieldKey).toBe('sector')
    expect(results[0].value).toBeNull()
  })

  it('returns the set value for a field', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'sector', label: 'Sector', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-1', valueText: 'Fintech', valueNumber: null, valueBoolean: null, valueDate: null, valueRefId: null })
    const results = getFieldValuesForEntity('company', 'co-1')
    expect(results[0].value?.valueText).toBe('Fintech')
  })

  it('resolves contact_ref label', () => {
    testDb.prepare(`INSERT INTO contacts (id, full_name) VALUES (?, ?)`).run('contact-abc', 'Jane Doe')
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'referral', label: 'Referral', fieldType: 'contact_ref', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-1', valueText: null, valueNumber: null, valueBoolean: null, valueDate: null, valueRefId: 'contact-abc' })
    const results = getFieldValuesForEntity('company', 'co-1')
    expect(results[0].value?.valueRefId).toBe('contact-abc')
    expect(results[0].value?.resolvedLabel).toBe('Jane Doe')
  })

  it('resolves company_ref label', () => {
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES (?, ?)`).run('org-xyz', 'Acme Corp')
    const def = createFieldDefinition({ entityType: 'contact', fieldKey: 'portfolio_co', label: 'Portfolio Co', fieldType: 'company_ref', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'contact', entityId: 'ct-1', valueText: null, valueNumber: null, valueBoolean: null, valueDate: null, valueRefId: 'org-xyz' })
    const results = getFieldValuesForEntity('contact', 'ct-1')
    expect(results[0].value?.resolvedLabel).toBe('Acme Corp')
  })
})

// ---------------------------------------------------------------------------
// Section field — createFieldDefinition, updateFieldDefinition, sectionedFields
// ---------------------------------------------------------------------------
describe('section field', () => {
  it('createFieldDefinition stores and returns section', () => {
    const def = createFieldDefinition({
      entityType: 'contact',
      label: 'Thesis Focus',
      fieldType: 'text',
      section: 'investor_info',
    })
    expect(def.section).toBe('investor_info')
  })

  it('createFieldDefinition defaults section to null when not provided', () => {
    const def = createFieldDefinition({
      entityType: 'company',
      label: 'Notes',
      fieldType: 'textarea',
    })
    expect(def.section).toBeNull()
  })

  it('updateFieldDefinition sets section column', () => {
    const def = createFieldDefinition({ entityType: 'contact', label: 'Bio', fieldType: 'textarea' })
    expect(def.section).toBeNull()
    const updated = updateFieldDefinition(def.id, { section: 'professional' })
    expect(updated?.section).toBe('professional')
  })

  it('updateFieldDefinition clears section when set to null', () => {
    const def = createFieldDefinition({ entityType: 'contact', label: 'Bio', fieldType: 'textarea', section: 'professional' })
    const updated = updateFieldDefinition(def.id, { section: null })
    expect(updated?.section).toBeNull()
  })

  it('section filtering: fields.filter(!f.section) excludes sectioned fields', () => {
    const fields = [
      { id: '1', section: null },
      { id: '2', section: 'contact_info' },
      { id: '3', section: null },
      { id: '4', section: 'professional' },
    ] as Array<{ id: string; section: string | null }>
    const unsectioned = fields.filter((f) => !f.section)
    expect(unsectioned.map((f) => f.id)).toEqual(['1', '3'])
  })

  it('sectionedFields helper returns only fields matching section, empty for unknown', () => {
    const fields = [
      { id: '1', section: 'contact_info' },
      { id: '2', section: 'professional' },
      { id: '3', section: null },
    ] as Array<{ id: string; section: string | null }>
    const sectionedFields = (key: string) => fields.filter((f) => f.section === key)
    expect(sectionedFields('contact_info').map((f) => f.id)).toEqual(['1'])
    expect(sectionedFields('professional').map((f) => f.id)).toEqual(['2'])
    expect(sectionedFields('investor_info')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// runCustomFieldSectionMigration — idempotency
// ---------------------------------------------------------------------------
describe('runCustomFieldSectionMigration', () => {
  it('is idempotent — running twice does not throw', () => {
    expect(() => runCustomFieldSectionMigration(testDb)).not.toThrow()
    expect(() => runCustomFieldSectionMigration(testDb)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Pref migration logic
// ---------------------------------------------------------------------------
describe('pref migration: copy custom: keys from summary-fields to pinned-fields', () => {
  it('copies custom: keys when pinned-fields is empty', () => {
    const summaryFields = ['custom:abc', 'entityType', 'custom:def']
    const pinnedFields: string[] = []
    // Simulate the migration guard
    let result = pinnedFields
    if (pinnedFields.length === 0) {
      const customKeys = summaryFields.filter((k) => k.startsWith('custom:'))
      if (customKeys.length > 0) result = customKeys
    }
    expect(result).toEqual(['custom:abc', 'custom:def'])
  })

  it('does not overwrite pinned-fields when it already has values', () => {
    const summaryFields = ['custom:abc', 'entityType']
    const pinnedFields = ['custom:xyz']
    // Simulate the migration guard
    let result = pinnedFields
    if (pinnedFields.length === 0) {
      const customKeys = summaryFields.filter((k) => k.startsWith('custom:'))
      if (customKeys.length > 0) result = customKeys
    }
    expect(result).toEqual(['custom:xyz'])
  })

  it('skips copy when summary-fields has no custom: keys', () => {
    const summaryFields = ['entityType', 'pipelineStage']
    const pinnedFields: string[] = []
    let result = pinnedFields
    if (pinnedFields.length === 0) {
      const customKeys = summaryFields.filter((k) => k.startsWith('custom:'))
      if (customKeys.length > 0) result = customKeys
    }
    expect(result).toEqual([])
  })
})
