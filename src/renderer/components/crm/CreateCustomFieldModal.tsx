import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CustomFieldDefinition, CustomFieldType } from '../../../shared/types/custom-fields'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { FIELD_TYPES, slugify } from '../../utils/customFieldUtils'
import { api } from '../../api'
import styles from './CreateCustomFieldModal.module.css'

interface CreateCustomFieldModalProps {
  entityType: 'company' | 'contact'
  onSaved: (def: CustomFieldDefinition) => void
  onClose: () => void
}

interface FormState {
  label: string
  fieldKey: string
  fieldKeyTouched: boolean
  fieldType: CustomFieldType
  options: string[]
  required: boolean
}

export function CreateCustomFieldModal({ entityType, onSaved, onClose }: CreateCustomFieldModalProps) {
  const [form, setForm] = useState<FormState>({
    label: '',
    fieldKey: '',
    fieldKeyTouched: false,
    fieldType: 'text',
    options: [],
    required: false,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const firstOptionRef = useRef<HTMLInputElement>(null)
  const optionsListRef = useRef<HTMLDivElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)

  // Focus label on mount
  useEffect(() => {
    labelInputRef.current?.focus()
  }, [])

  // Auto-focus first option input when type switches to select/multiselect
  useEffect(() => {
    if (form.fieldType === 'select' || form.fieldType === 'multiselect') {
      if (form.options.length === 0) {
        setForm((f) => ({ ...f, options: [''] }))
      }
      setTimeout(() => firstOptionRef.current?.focus(), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.fieldType])

  function handleLabelChange(label: string) {
    setForm((f) => ({
      ...f,
      label,
      fieldKey: f.fieldKeyTouched ? f.fieldKey : slugify(label),
    }))
  }

  function updateOption(i: number, value: string) {
    const next = [...form.options]
    next[i] = value
    setForm((f) => ({ ...f, options: next }))
  }

  function addOption() {
    setForm((f) => ({ ...f, options: [...f.options, ''] }))
  }

  function removeOption(i: number) {
    setForm((f) => ({ ...f, options: f.options.filter((_, j) => j !== i) }))
  }

  async function handleSave() {
    if (!form.label.trim()) { setError('Label is required'); return }
    if (!form.fieldKey.trim()) { setError('Field key is required'); return }

    const optionsJson =
      (form.fieldType === 'select' || form.fieldType === 'multiselect') &&
      form.options.filter((o) => o.trim()).length > 0
        ? JSON.stringify(form.options.filter((o) => o.trim()))
        : null

    setSaving(true)
    setError(null)
    const r = await api.invoke<{ success: boolean; data?: CustomFieldDefinition; message?: string }>(
      IPC_CHANNELS.CUSTOM_FIELD_CREATE_DEFINITION,
      {
        entityType,
        label: form.label.trim(),
        fieldKey: form.fieldKey.trim(),
        fieldType: form.fieldType,
        optionsJson,
        isRequired: form.required,
        sortOrder: 999,
        showInList: true,
      }
    )
    setSaving(false)
    if (r.success && r.data) {
      onSaved(r.data)
    } else {
      setError(r.message ?? 'Failed to create field')
    }
  }

  const isSelect = form.fieldType === 'select' || form.fieldType === 'multiselect'

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>New custom field</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.body}>
          {error && <div className={styles.errorBanner}>{error}</div>}

          <div className={styles.row}>
            <label className={styles.label}>Label</label>
            <input
              ref={labelInputRef}
              className={styles.input}
              value={form.label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="e.g. Investment Focus"
            />
          </div>

          <div className={styles.row}>
            <label className={styles.label}>Field key</label>
            <input
              className={styles.input}
              value={form.fieldKey}
              onChange={(e) => setForm((f) => ({ ...f, fieldKey: e.target.value, fieldKeyTouched: true }))}
              placeholder="e.g. investment_focus"
            />
          </div>

          <div className={styles.row}>
            <label className={styles.label}>Type</label>
            <select
              className={styles.select}
              value={form.fieldType}
              onChange={(e) => setForm((f) => ({ ...f, fieldType: e.target.value as CustomFieldType, options: [] }))}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {isSelect && (
            <div className={styles.row}>
              <label className={styles.label}>Options</label>
              <div ref={optionsListRef} className={styles.optionsList}>
                {form.options.map((opt, i) => (
                  <div key={i} className={styles.optionItem}>
                    <input
                      ref={i === 0 ? firstOptionRef : undefined}
                      className={styles.optionInput}
                      value={opt}
                      onChange={(e) => updateOption(i, e.target.value)}
                      placeholder={`Option ${i + 1}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addOption()
                          setTimeout(() => {
                            const inputs = optionsListRef.current?.querySelectorAll('input')
                            inputs?.[inputs.length - 1]?.focus()
                          }, 0)
                        }
                        if (e.key === 'Backspace' && opt === '' && form.options.length > 1) {
                          e.preventDefault()
                          removeOption(i)
                          setTimeout(() => {
                            const inputs = optionsListRef.current?.querySelectorAll('input')
                            inputs?.[Math.max(0, i - 1)]?.focus()
                          }, 0)
                        }
                      }}
                    />
                    <button className={styles.removeBtn} onClick={() => removeOption(i)}>×</button>
                  </div>
                ))}
                <button className={styles.addOptionBtn} onClick={addOption}>+ Add option</button>
              </div>
            </div>
          )}

          <div className={styles.row}>
            <label className={styles.checkLabel}>
              <input
                type="checkbox"
                checked={form.required}
                onChange={(e) => setForm((f) => ({ ...f, required: e.target.checked }))}
              />
              Required
            </label>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Creating…' : 'Create field'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
