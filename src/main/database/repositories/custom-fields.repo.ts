import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type {
  CustomFieldDefinition,
  CustomFieldEntityType,
  CustomFieldWithValue,
  CreateCustomFieldDefinitionInput,
  UpdateCustomFieldDefinitionInput,
  SetCustomFieldValueInput
} from '../../../shared/types/custom-fields'

const FIELD_KEY_REGEX = /^[a-z0-9_]+$/

// Maps built-in camelCase field keys to their DB table and column names.
// Column names come from this hardcoded map only — NOT from user input (no SQL injection risk).
const FIELD_KEY_MAP: Record<string, { table: string; column: string }> = {
  entityType:         { table: 'org_companies', column: 'entity_type' },
  pipelineStage:      { table: 'org_companies', column: 'pipeline_stage' },
  priority:           { table: 'org_companies', column: 'priority' },
  round:              { table: 'org_companies', column: 'round' },
  targetCustomer:     { table: 'org_companies', column: 'target_customer' },
  businessModel:      { table: 'org_companies', column: 'business_model' },
  productStage:       { table: 'org_companies', column: 'product_stage' },
  employeeCountRange: { table: 'org_companies', column: 'employee_count_range' },
  contactType:        { table: 'contacts',      column: 'contact_type' },
}

function rowToDefinition(row: Record<string, unknown>): CustomFieldDefinition {
  return {
    id: row.id as string,
    entityType: row.entity_type as CustomFieldEntityType,
    fieldKey: row.field_key as string,
    label: row.label as string,
    fieldType: row.field_type as CustomFieldDefinition['fieldType'],
    optionsJson: (row.options_json as string | null) ?? null,
    isRequired: Boolean(row.is_required),
    sortOrder: row.sort_order as number,
    showInList: Boolean(row.show_in_list),
    isBuiltin: Boolean(row.is_builtin),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function getFieldDefinitionById(id: string): CustomFieldDefinition | null {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT * FROM custom_field_definitions WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  return row ? rowToDefinition(row) : null
}

export function countBuiltinOptionUsage(fieldKey: string, value: string): number {
  const mapping = FIELD_KEY_MAP[fieldKey]
  if (!mapping) return 0
  const db = getDatabase()
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM ${mapping.table} WHERE ${mapping.column} = ?`)
    .get(value) as { n: number }
  return row.n
}

export function renameBuiltinOption(
  defId: string,
  fieldKey: string,
  oldValue: string,
  newValue: string
): void {
  const db = getDatabase()
  const def = getFieldDefinitionById(defId)
  if (!def) throw new Error(`[custom-fields.repo] renameBuiltinOption: def not found: ${defId}`)

  let arr: string[] = []
  if (def.optionsJson) {
    try { arr = JSON.parse(def.optionsJson) } catch { arr = [] }
  }
  const idx = arr.indexOf(oldValue)
  if (idx === -1) return // idempotent: value already renamed or doesn't exist

  const updated = [...arr]
  updated[idx] = newValue
  const newJson = JSON.stringify(updated)
  const now = new Date().toISOString()

  const mapping = FIELD_KEY_MAP[fieldKey]

  const doRename = db.transaction(() => {
    db.prepare(
      `UPDATE custom_field_definitions SET options_json = ?, updated_at = ? WHERE id = ?`
    ).run(newJson, now, defId)

    if (mapping) {
      db.prepare(
        `UPDATE ${mapping.table} SET ${mapping.column} = ? WHERE ${mapping.column} = ?`
      ).run(newValue, oldValue)
    }
  })
  doRename()
}

export function listFieldDefinitions(entityType: CustomFieldEntityType): CustomFieldDefinition[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT * FROM custom_field_definitions WHERE entity_type = ? ORDER BY sort_order ASC, created_at ASC`
    )
    .all(entityType) as Record<string, unknown>[]
  return rows.map(rowToDefinition)
}

export function createFieldDefinition(data: CreateCustomFieldDefinitionInput): CustomFieldDefinition {
  if (!FIELD_KEY_REGEX.test(data.fieldKey)) {
    throw new Error(`Invalid field_key "${data.fieldKey}": must match /^[a-z0-9_]+$/`)
  }
  const db = getDatabase()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO custom_field_definitions
      (id, entity_type, field_key, label, field_type, options_json, is_required, sort_order, show_in_list, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.entityType,
    data.fieldKey,
    data.label,
    data.fieldType,
    data.optionsJson ?? null,
    data.isRequired ? 1 : 0,
    data.sortOrder ?? 0,
    data.showInList ? 1 : 0,
    now,
    now
  )
  return rowToDefinition(
    db.prepare(`SELECT * FROM custom_field_definitions WHERE id = ?`).get(id) as Record<string, unknown>
  )
}

export function updateFieldDefinition(
  id: string,
  updates: UpdateCustomFieldDefinitionInput
): CustomFieldDefinition | null {
  const db = getDatabase()
  const existing = db
    .prepare(`SELECT * FROM custom_field_definitions WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  if (!existing) return null

  const now = new Date().toISOString()
  db.prepare(
    `UPDATE custom_field_definitions SET
      label = ?,
      field_type = ?,
      options_json = ?,
      is_required = ?,
      sort_order = ?,
      show_in_list = ?,
      updated_at = ?
    WHERE id = ?`
  ).run(
    updates.label ?? existing.label,
    updates.fieldType ?? existing.field_type,
    'optionsJson' in updates ? (updates.optionsJson ?? null) : existing.options_json,
    'isRequired' in updates ? (updates.isRequired ? 1 : 0) : existing.is_required,
    updates.sortOrder ?? existing.sort_order,
    'showInList' in updates ? (updates.showInList ? 1 : 0) : existing.show_in_list,
    now,
    id
  )
  return rowToDefinition(
    db.prepare(`SELECT * FROM custom_field_definitions WHERE id = ?`).get(id) as Record<string, unknown>
  )
}

export function deleteFieldDefinition(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare(`DELETE FROM custom_field_definitions WHERE id = ?`).run(id)
  return result.changes > 0
}

export function reorderFieldDefinitions(orderedIds: string[]): void {
  const db = getDatabase()
  const update = db.prepare(`UPDATE custom_field_definitions SET sort_order = ?, updated_at = ? WHERE id = ?`)
  const now = new Date().toISOString()
  const transaction = db.transaction(() => {
    orderedIds.forEach((id, index) => {
      const result = update.run(index, now, id)
      if (result.changes === 0) {
        console.warn(`[custom-fields.repo] reorderFieldDefinitions: unknown id "${id}", skipping`)
      }
    })
  })
  transaction()
}

export function getFieldValuesForEntity(
  entityType: CustomFieldEntityType,
  entityId: string
): CustomFieldWithValue[] {
  const db = getDatabase()

  const defs = db
    .prepare(
      `SELECT * FROM custom_field_definitions WHERE entity_type = ? ORDER BY sort_order ASC, created_at ASC`
    )
    .all(entityType) as Record<string, unknown>[]

  if (defs.length === 0) return []

  // Fetch all values for this entity in one query
  const values = db
    .prepare(
      `SELECT
        cfv.*,
        CASE
          WHEN cfd.field_type = 'contact_ref' THEN c.full_name
          WHEN cfd.field_type = 'company_ref' THEN oc.canonical_name
          ELSE NULL
        END AS resolved_label
       FROM custom_field_values cfv
       JOIN custom_field_definitions cfd ON cfv.field_definition_id = cfd.id
       LEFT JOIN contacts c ON cfd.field_type = 'contact_ref' AND cfv.value_ref_id = c.id
       LEFT JOIN org_companies oc ON cfd.field_type = 'company_ref' AND cfv.value_ref_id = oc.id
       WHERE cfv.entity_type = ? AND cfv.entity_id = ?`
    )
    .all(entityType, entityId) as Record<string, unknown>[]

  const valuesByDefId = new Map(values.map((v) => [v.field_definition_id as string, v]))

  return defs.map((def) => {
    const raw = valuesByDefId.get(def.id as string) ?? null
    return {
      ...rowToDefinition(def),
      value: raw
        ? {
            id: raw.id as string,
            fieldDefinitionId: raw.field_definition_id as string,
            entityType: raw.entity_type as CustomFieldEntityType,
            entityId: raw.entity_id as string,
            valueText: (raw.value_text as string | null) ?? null,
            valueNumber: (raw.value_number as number | null) ?? null,
            valueBoolean: raw.value_boolean != null ? Boolean(raw.value_boolean) : null,
            valueDate: (raw.value_date as string | null) ?? null,
            valueRefId: (raw.value_ref_id as string | null) ?? null,
            resolvedLabel: (raw.resolved_label as string | null) ?? null,
            createdAt: raw.created_at as string,
            updatedAt: raw.updated_at as string
          }
        : null
    }
  })
}

export function setFieldValue(input: SetCustomFieldValueInput): void {
  const db = getDatabase()
  const id = randomUUID()
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO custom_field_values
      (id, field_definition_id, entity_type, entity_id, value_text, value_number, value_boolean, value_date, value_ref_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(field_definition_id, entity_id) DO UPDATE SET
       value_text = excluded.value_text,
       value_number = excluded.value_number,
       value_boolean = excluded.value_boolean,
       value_date = excluded.value_date,
       value_ref_id = excluded.value_ref_id,
       updated_at = excluded.updated_at`
  ).run(
    id,
    input.fieldDefinitionId,
    input.entityType,
    input.entityId,
    input.valueText ?? null,
    input.valueNumber ?? null,
    input.valueBoolean != null ? (input.valueBoolean ? 1 : 0) : null,
    input.valueDate ?? null,
    input.valueRefId ?? null,
    now,
    now
  )
}

export function deleteFieldValue(fieldDefinitionId: string, entityId: string): boolean {
  const db = getDatabase()
  const result = db
    .prepare(`DELETE FROM custom_field_values WHERE field_definition_id = ? AND entity_id = ?`)
    .run(fieldDefinitionId, entityId)
  return result.changes > 0
}

export function countFieldValues(fieldDefinitionId: string): number {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM custom_field_values WHERE field_definition_id = ?`)
    .get(fieldDefinitionId) as { count: number }
  return row.count
}

/**
 * Returns field values for multiple field definitions across all entities of the given type.
 * Used to populate custom field columns in the table list view.
 *
 * Returns: { [entityId]: { [fieldDefinitionId]: displayString } }
 */
export function getBulkFieldValues(
  entityType: CustomFieldEntityType,
  fieldDefinitionIds: string[]
): Record<string, Record<string, string>> {
  if (fieldDefinitionIds.length === 0) return {}
  const db = getDatabase()
  const placeholders = fieldDefinitionIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT cfv.entity_id, cfv.field_definition_id,
              cfv.value_text, cfv.value_number, cfv.value_boolean, cfv.value_date,
              cfd.field_type
       FROM custom_field_values cfv
       JOIN custom_field_definitions cfd ON cfv.field_definition_id = cfd.id
       WHERE cfv.entity_type = ? AND cfv.field_definition_id IN (${placeholders})`
    )
    .all(entityType, ...fieldDefinitionIds) as Record<string, unknown>[]

  const result: Record<string, Record<string, string>> = {}
  for (const row of rows) {
    const eid = row.entity_id as string
    const did = row.field_definition_id as string
    if (!result[eid]) result[eid] = {}
    const ft = row.field_type as string
    if (ft === 'boolean') {
      result[eid][did] = row.value_boolean ? 'Yes' : 'No'
    } else if (ft === 'number' || ft === 'currency') {
      result[eid][did] = row.value_number != null ? String(row.value_number) : ''
    } else if (ft === 'date') {
      result[eid][did] = (row.value_date as string | null) ?? ''
    } else {
      result[eid][did] = (row.value_text as string | null) ?? ''
    }
  }
  return result
}
