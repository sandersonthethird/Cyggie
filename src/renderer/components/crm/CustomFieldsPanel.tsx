import { useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CustomFieldEntityType, CustomFieldWithValue, SetCustomFieldValueInput } from '../../../shared/types/custom-fields'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { usePreferencesStore } from '../../stores/preferences.store'
import { addCustomFieldOption } from '../../utils/customFieldUtils'
import { PropertyRow } from './PropertyRow'
import styles from './CustomFieldsPanel.module.css'
import { api } from '../../api'

interface CustomFieldsPanelProps {
  entityType: CustomFieldEntityType
  entityId: string
  onFieldsLoaded?: (fields: CustomFieldWithValue[]) => void
  onCreateField?: () => void
  draggingFieldId?: string | null
  onDropToUnsectioned?: () => void
}

export function CustomFieldsPanel({ entityType, entityId, onFieldsLoaded, onCreateField, draggingFieldId, onDropToUnsectioned }: CustomFieldsPanelProps) {
  const { load, loaded, version, companyDefs, contactDefs } = useCustomFieldStore()
  const { getJSON, setJSON } = usePreferencesStore()
  const [fields, setFields] = useState<CustomFieldWithValue[]>([])
  const [loading, setLoading] = useState(true)
  const [dropHighlight, setDropHighlight] = useState(false)

  const defs = (entityType === 'company' ? companyDefs : contactDefs).filter((d) => !d.isBuiltin)
  const prefKey = `cyggie:${entityType}-pinned-fields`
  const pinnedKeys = getJSON<string[]>(prefKey, [])
  const dropCounter = useRef(0)

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
        if (res.success && res.data) {
          setFields(res.data)
          onFieldsLoaded?.(res.data)
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [entityType, entityId, loaded, version]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!loaded || loading) return null
  if (defs.length === 0 && !onCreateField) return null


  function togglePin(id: string) {
    const key = `custom:${id}`
    const next = pinnedKeys.includes(key)
      ? pinnedKeys.filter((k) => k !== key)
      : [...pinnedKeys, key]
    setJSON(prefKey, next)
  }

  async function handleSave(field: CustomFieldWithValue, newValue: string | number | boolean | null) {
    if (newValue == null || newValue === '') {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE, field.id, entityId)
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

    await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
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

  const unsectionedFields = fields.filter((f) => !f.section)

  if (unsectionedFields.length === 0 && defs.filter(d => !d.section).length === 0 && !onCreateField) return null

  const panelDropProps = draggingFieldId && onDropToUnsectioned ? {
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDragEnter: () => { dropCounter.current++; setDropHighlight(true) },
    onDragLeave: () => { if (--dropCounter.current === 0) setDropHighlight(false) },
    onDrop: () => { dropCounter.current = 0; setDropHighlight(false); onDropToUnsectioned() },
  } : {}

  return (
    <div className={`${styles.panel} ${dropHighlight ? styles.dropTarget : ''}`} {...panelDropProps}>
      <div className={styles.sectionHeader}>Custom Fields</div>
      {unsectionedFields.map((field) => {
        const isPinned = pinnedKeys.includes(`custom:${field.id}`)
        return (
          <div key={field.id} className={styles.fieldRow}>
            <PropertyRow
              label={field.label}
              value={getFieldValue(field)}
              type={field.fieldType}
              options={getOptions(field)}
              resolvedLabel={field.value?.resolvedLabel ?? null}
              onSave={(val) => handleSave(field, val)}
              onAddOption={
                (field.fieldType === 'select' || field.fieldType === 'multiselect')
                  ? async (newOption) => {
                      const opt = newOption.trim().slice(0, 200)
                      await addCustomFieldOption(field.id, field.optionsJson, opt)
                      // Optimistic local update: use functional form to read latest
                      // state, not the stale `field` closure.
                      setFields((prev) =>
                        prev.map((f) => {
                          if (f.id !== field.id) return f
                          const current: string[] = (() => {
                            try { return JSON.parse(f.optionsJson ?? '[]') } catch { return [] }
                          })()
                          return { ...f, optionsJson: JSON.stringify([...current, opt]) }
                        })
                      )
                    }
                  : undefined
              }
            />
            <button
              className={`${styles.pinBtn} ${isPinned ? styles.pinned : ''}`}
              title={isPinned ? 'Remove from Pinned section' : 'Pin to Pinned section'}
              onClick={() => togglePin(field.id)}
            >
              📌
            </button>
          </div>
        )
      })}
      {onCreateField && (
        <button className={styles.newFieldBtn} onClick={onCreateField}>
          + New custom field
        </button>
      )}
    </div>
  )
}
