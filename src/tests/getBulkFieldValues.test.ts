import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runCustomFieldDefinitionsMigration } from '../main/database/migrations/039-custom-field-definitions'
import { runCustomFieldValuesMigration } from '../main/database/migrations/040-custom-field-values'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { getBulkFieldValues, createFieldDefinition, setFieldValue } = await import(
  '../main/database/repositories/custom-fields.repo'
)

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, full_name TEXT);
    CREATE TABLE IF NOT EXISTS org_companies (id TEXT PRIMARY KEY, canonical_name TEXT);
  `)
  runCustomFieldDefinitionsMigration(db)
  runCustomFieldValuesMigration(db)
  return db
}

beforeEach(() => {
  testDb = makeTestDb()
})

describe('getBulkFieldValues', () => {
  it('returns empty object when fieldDefinitionIds is empty (no DB hit)', () => {
    const result = getBulkFieldValues('company', [])
    expect(result).toEqual({})
  })

  it('returns empty object when no values exist for given def ids', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'focus', label: 'Focus', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    const result = getBulkFieldValues('company', [def.id])
    expect(result).toEqual({})
  })

  it('text field: returns value_text, null → empty string', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'notes', label: 'Notes', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-1', valueText: 'hello' })

    const result = getBulkFieldValues('company', [def.id])
    expect(result['co-1'][def.id]).toBe('hello')
  })

  it('number field: returns String(value_number), null → empty string', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'score', label: 'Score', fieldType: 'number', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-1', valueNumber: 42 })

    const result = getBulkFieldValues('company', [def.id])
    expect(result['co-1'][def.id]).toBe('42')
  })

  it('currency field: returns String(value_number)', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'aum', label: 'AUM', fieldType: 'currency', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-2', valueNumber: 1000000 })

    const result = getBulkFieldValues('company', [def.id])
    expect(result['co-2'][def.id]).toBe('1000000')
  })

  it('boolean field: value_boolean=1 → "Yes", value_boolean=0 → "No"', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'active', label: 'Active', fieldType: 'boolean', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-yes', valueBoolean: true })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-no', valueBoolean: false })

    const result = getBulkFieldValues('company', [def.id])
    expect(result['co-yes'][def.id]).toBe('Yes')
    expect(result['co-no'][def.id]).toBe('No')
  })

  it('date field: returns value_date passthrough, null → empty string', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'founded', label: 'Founded', fieldType: 'date', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-1', valueDate: '2020-01-15' })

    const result = getBulkFieldValues('company', [def.id])
    expect(result['co-1'][def.id]).toBe('2020-01-15')
  })

  it('select field: returns value_text', () => {
    const def = createFieldDefinition({ entityType: 'company', fieldKey: 'stage', label: 'Stage', fieldType: 'select', optionsJson: '["Seed","Series A"]', isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'company', entityId: 'co-1', valueText: 'Seed' })

    const result = getBulkFieldValues('company', [def.id])
    expect(result['co-1'][def.id]).toBe('Seed')
  })

  it('multiple entities, multiple defs — correctly grouped by entityId', () => {
    const defA = createFieldDefinition({ entityType: 'company', fieldKey: 'field_a', label: 'A', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    const defB = createFieldDefinition({ entityType: 'company', fieldKey: 'field_b', label: 'B', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 1 })

    setFieldValue({ fieldDefinitionId: defA.id, entityType: 'company', entityId: 'co-1', valueText: 'a1' })
    setFieldValue({ fieldDefinitionId: defB.id, entityType: 'company', entityId: 'co-1', valueText: 'b1' })
    setFieldValue({ fieldDefinitionId: defA.id, entityType: 'company', entityId: 'co-2', valueText: 'a2' })

    const result = getBulkFieldValues('company', [defA.id, defB.id])
    expect(result['co-1'][defA.id]).toBe('a1')
    expect(result['co-1'][defB.id]).toBe('b1')
    expect(result['co-2'][defA.id]).toBe('a2')
    expect(result['co-2'][defB.id]).toBeUndefined()
  })

  it('does not return values for a different entityType', () => {
    const def = createFieldDefinition({ entityType: 'contact', fieldKey: 'tier', label: 'Tier', fieldType: 'text', optionsJson: null, isRequired: false, showInList: false, sortOrder: 0 })
    setFieldValue({ fieldDefinitionId: def.id, entityType: 'contact', entityId: 'contact-1', valueText: 'Gold' })

    // Query for 'company' with the same def id — should return nothing
    const result = getBulkFieldValues('company', [def.id])
    expect(result).toEqual({})
  })

  it('unknown entityType (no rows) → returns {}', () => {
    const result = getBulkFieldValues('company', ['nonexistent-def'])
    expect(result).toEqual({})
  })
})
