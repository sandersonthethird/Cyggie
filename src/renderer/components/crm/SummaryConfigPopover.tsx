import { useEffect, useRef } from 'react'
import type { ColumnDef } from './tableUtils'
import type { CustomFieldDefinition, CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { formatCurrency, formatDate } from '../../utils/format'
import styles from './SummaryConfigPopover.module.css'

interface SummaryConfigPopoverProps {
  pinnedKeys: string[]
  onToggle: (key: string) => void
  columnDefs: ColumnDef[]
  customDefs: CustomFieldDefinition[]
  entityData: Record<string, unknown>
  customFields: CustomFieldWithValue[]
  headerKeys: Set<string>
  onClose: () => void
}

function formatFieldValue(value: unknown, type: string): string {
  if (value == null || value === '') return ''
  switch (type) {
    case 'currency': return formatCurrency(Number(value))
    case 'date': return formatDate(String(value))
    default: return String(value)
  }
}

function formatCustomFieldValue(field: CustomFieldWithValue): string {
  if (!field.value) return ''
  const { fieldType, value } = field
  switch (fieldType) {
    case 'number':
    case 'currency':
      return value.valueNumber != null ? formatCurrency(value.valueNumber) : ''
    case 'boolean':
      return value.valueBoolean != null ? (value.valueBoolean ? 'Yes' : 'No') : ''
    case 'date':
      return value.valueDate ? formatDate(value.valueDate) : ''
    case 'contact_ref':
    case 'company_ref':
      return value.resolvedLabel ?? (value.valueRefId ?? '')
    default:
      return value.valueText ?? ''
  }
}

export function SummaryConfigPopover({
  pinnedKeys,
  onToggle,
  columnDefs,
  customDefs,
  entityData,
  customFields,
  headerKeys,
  onClose
}: SummaryConfigPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  const pinnableColumns = columnDefs.filter(
    (col) => col.type !== 'computed' && col.field != null && !headerKeys.has(col.key)
  )

  return (
    <div ref={ref} className={styles.popover}>
      <div className={styles.popoverHeader}>Configure summary</div>

      {pinnableColumns.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Built-in fields</div>
          {pinnableColumns.map((col) => {
            const isPinned = pinnedKeys.includes(col.key)
            const rawValue = col.field ? entityData[col.field] : undefined
            const preview = formatFieldValue(rawValue, col.type)
            return (
              <button
                key={col.key}
                className={`${styles.fieldRow} ${isPinned ? styles.active : ''}`}
                onClick={() => onToggle(col.key)}
              >
                <span className={styles.checkIcon}>{isPinned ? '☑' : '☐'}</span>
                <span className={styles.fieldLabel}>{col.label}</span>
                {preview && <span className={styles.fieldPreview}>{preview}</span>}
              </button>
            )
          })}
        </div>
      )}

      {customDefs.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionLabel}>Custom fields</div>
          {customDefs.map((def) => {
            const key = `custom:${def.id}`
            const isPinned = pinnedKeys.includes(key)
            const fieldWithValue = customFields.find((f) => f.id === def.id)
            const preview = fieldWithValue ? formatCustomFieldValue(fieldWithValue) : ''
            return (
              <button
                key={def.id}
                className={`${styles.fieldRow} ${isPinned ? styles.active : ''}`}
                onClick={() => onToggle(key)}
              >
                <span className={styles.checkIcon}>{isPinned ? '☑' : '☐'}</span>
                <span className={styles.fieldLabel}>{def.label}</span>
                {preview && <span className={styles.fieldPreview}>{preview}</span>}
              </button>
            )
          })}
        </div>
      )}

      {pinnableColumns.length === 0 && customDefs.length === 0 && (
        <div className={styles.empty}>No fields available to pin.</div>
      )}
    </div>
  )
}
