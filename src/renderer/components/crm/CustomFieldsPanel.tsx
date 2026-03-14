import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CustomFieldEntityType, CustomFieldWithValue, SetCustomFieldValueInput } from '../../../shared/types/custom-fields'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { PropertyRow } from './PropertyRow'
import styles from './CustomFieldsPanel.module.css'

interface CustomFieldsPanelProps {
  entityType: CustomFieldEntityType
  entityId: string
}

export function CustomFieldsPanel({ entityType, entityId }: CustomFieldsPanelProps) {
  const { load, loaded, companyDefs, contactDefs } = useCustomFieldStore()
  const [fields, setFields] = useState<CustomFieldWithValue[]>([])
  const [loading, setLoading] = useState(true)

  const defs = entityType === 'company' ? companyDefs : contactDefs

  useEffect(() => {
    if (!loaded) {
      load()
    }
  }, [loaded, load])

  useEffect(() => {
    if (!loaded) return
    setLoading(true)
    window.api
      .invoke<{ success: boolean; data?: CustomFieldWithValue[] }>(
        IPC_CHANNELS.CUSTOM_FIELD_GET_VALUES,
        entityType,
        entityId
      )
      .then((res) => {
        if (res.success && res.data) setFields(res.data)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [entityType, entityId, loaded])

  if (!loaded || loading) return null
  if (defs.length === 0) return null

  async function handleSave(field: CustomFieldWithValue, newValue: string | number | boolean | null) {
    if (newValue == null || newValue === '') {
      await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE, field.id, entityId)
      setFields((prev) =>
        prev.map((f) => (f.id === field.id ? { ...f, value: null } : f))
      )
      return
    }

    const input: SetCustomFieldValueInput = {
      fieldDefinitionId: field.id,
      entityId,
      entityType,
    }

    switch (field.fieldType) {
      case 'number':
      case 'currency':
        input.valueNumber = Number(newValue)
        break
      case 'boolean':
        input.valueBoolean = Boolean(newValue)
        break
      case 'date':
        input.valueDate = String(newValue)
        break
      case 'contact_ref':
      case 'company_ref':
        input.valueRefId = String(newValue)
        break
      default:
        input.valueText = String(newValue)
    }

    await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
  }

  function getFieldValue(field: CustomFieldWithValue): string | number | boolean | null {
    if (!field.value) return null
    switch (field.fieldType) {
      case 'number':
      case 'currency':
        return field.value.valueNumber
      case 'boolean':
        return field.value.valueBoolean
      case 'date':
        return field.value.valueDate
      case 'contact_ref':
      case 'company_ref':
        return field.value.valueRefId
      default:
        return field.value.valueText
    }
  }

  function getOptions(field: CustomFieldWithValue): string[] {
    if (!field.optionsJson) return []
    try {
      return JSON.parse(field.optionsJson)
    } catch {
      return []
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.sectionHeader}>Custom Fields</div>
      {fields.map((field) => (
        <PropertyRow
          key={field.id}
          label={field.label}
          value={getFieldValue(field)}
          type={field.fieldType}
          options={getOptions(field)}
          resolvedLabel={field.value?.resolvedLabel ?? null}
          onSave={(val) => handleSave(field, val)}
        />
      ))}
    </div>
  )
}
