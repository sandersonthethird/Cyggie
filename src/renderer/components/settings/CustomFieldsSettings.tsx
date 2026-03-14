import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type {
  CustomFieldDefinition,
  CustomFieldEntityType,
  CustomFieldType,
  CreateCustomFieldDefinitionInput
} from '../../../shared/types/custom-fields'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import styles from './CustomFieldsSettings.module.css'

const FIELD_TYPES: Array<{ value: CustomFieldType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Text (long)' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'url', label: 'URL' },
  { value: 'select', label: 'Select' },
  { value: 'multiselect', label: 'Multi-select' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'contact_ref', label: 'Contact link' },
  { value: 'company_ref', label: 'Company link' }
]

type EntityTab = 'company' | 'contact'

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

interface AddFieldFormData {
  label: string
  fieldKey: string
  fieldType: CustomFieldType
  optionsJson: string
  isRequired: boolean
  showInList: boolean
}

const EMPTY_FORM: AddFieldFormData = {
  label: '',
  fieldKey: '',
  fieldType: 'text',
  optionsJson: '',
  isRequired: false,
  showInList: false
}

interface DeleteConfirm {
  def: CustomFieldDefinition
  valueCount: number
}

export function CustomFieldsSettings() {
  const { companyDefs, contactDefs, refresh } = useCustomFieldStore()
  const [entityTab, setEntityTab] = useState<EntityTab>('company')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<AddFieldFormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Load defs on mount
  useEffect(() => {
    refresh()
  }, [])

  const defs = entityTab === 'company' ? companyDefs : contactDefs

  function handleLabelChange(label: string) {
    setForm((prev) => ({
      ...prev,
      label,
      fieldKey: prev.fieldKey || slugify(label)
    }))
  }

  async function handleCreate() {
    if (!form.label.trim()) {
      setFormError('Label is required')
      return
    }
    if (!form.fieldKey.trim()) {
      setFormError('Field key is required')
      return
    }
    if (!/^[a-z0-9_]+$/.test(form.fieldKey)) {
      setFormError('Field key must only contain lowercase letters, numbers, and underscores')
      return
    }

    const input: CreateCustomFieldDefinitionInput = {
      entityType: entityTab,
      fieldKey: form.fieldKey,
      label: form.label,
      fieldType: form.fieldType,
      optionsJson: form.optionsJson.trim() ? form.optionsJson : null,
      isRequired: form.isRequired,
      showInList: form.showInList,
      sortOrder: defs.length
    }

    setSaving(true)
    setFormError(null)
    try {
      const result = await window.api.invoke<{ success: boolean; message?: string }>(
        IPC_CHANNELS.CUSTOM_FIELD_CREATE_DEFINITION,
        input
      )
      if (!result.success) {
        setFormError(result.message ?? 'Failed to create field')
        return
      }
      await refresh()
      setForm(EMPTY_FORM)
      setShowForm(false)
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Failed to create field')
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteClick(def: CustomFieldDefinition) {
    const countResult = await window.api.invoke<{ success: boolean; count?: number }>(
      IPC_CHANNELS.CUSTOM_FIELD_COUNT_VALUES,
      def.id
    )
    const count = countResult.count ?? 0
    if (count === 0) {
      await doDelete(def)
    } else {
      setDeleteConfirm({ def, valueCount: count })
    }
  }

  async function doDelete(def: CustomFieldDefinition) {
    setDeleting(true)
    try {
      await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_DEFINITION, def.id)
      await refresh()
      setDeleteConfirm(null)
    } catch (e) {
      console.error('[CustomFieldsSettings] delete failed:', e)
    } finally {
      setDeleting(false)
    }
  }

  async function moveUp(def: CustomFieldDefinition, index: number) {
    if (index === 0) return
    const reordered = [...defs]
    reordered.splice(index, 1)
    reordered.splice(index - 1, 0, def)
    await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_REORDER_DEFINITIONS, reordered.map((d) => d.id))
    await refresh()
  }

  async function moveDown(def: CustomFieldDefinition, index: number) {
    if (index === defs.length - 1) return
    const reordered = [...defs]
    reordered.splice(index, 1)
    reordered.splice(index + 1, 0, def)
    await window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_REORDER_DEFINITIONS, reordered.map((d) => d.id))
    await refresh()
  }

  return (
    <div className={styles.root}>
      <h2 className={styles.title}>Custom Fields</h2>
      <p className={styles.description}>
        Add custom fields to Companies and Contacts for your specific workflow. Fields appear in the properties panel.
      </p>

      {/* Entity sub-tabs */}
      <div className={styles.entityTabs}>
        {(['company', 'contact'] as EntityTab[]).map((tab) => (
          <button
            key={tab}
            className={`${styles.entityTab} ${entityTab === tab ? styles.entityTabActive : ''}`}
            onClick={() => { setEntityTab(tab); setShowForm(false); setForm(EMPTY_FORM) }}
          >
            {tab === 'company' ? 'Companies' : 'Contacts'}
          </button>
        ))}
      </div>

      {/* Field list */}
      <div className={styles.fieldList}>
        {defs.length === 0 && !showForm && (
          <div className={styles.empty}>No custom fields yet. Add one below.</div>
        )}
        {defs.map((def, i) => (
          <div key={def.id} className={styles.fieldRow}>
            <div className={styles.fieldInfo}>
              <span className={styles.fieldLabel}>{def.label}</span>
              <span className={styles.fieldType}>{FIELD_TYPES.find((t) => t.value === def.fieldType)?.label ?? def.fieldType}</span>
              <span className={styles.fieldKey}>{def.fieldKey}</span>
            </div>
            <div className={styles.fieldActions}>
              <button className={styles.iconBtn} onClick={() => moveUp(def, i)} disabled={i === 0} title="Move up">↑</button>
              <button className={styles.iconBtn} onClick={() => moveDown(def, i)} disabled={i === defs.length - 1} title="Move down">↓</button>
              <button className={styles.deleteBtn} onClick={() => handleDeleteClick(def)}>Delete</button>
            </div>
          </div>
        ))}

        {/* Delete confirmation */}
        {deleteConfirm && (
          <div className={styles.deleteConfirm}>
            <span>
              This will permanently delete <strong>{deleteConfirm.valueCount}</strong> saved value{deleteConfirm.valueCount !== 1 ? 's' : ''} for "{deleteConfirm.def.label}". Continue?
            </span>
            <div className={styles.deleteConfirmActions}>
              <button
                className={styles.confirmDeleteBtn}
                onClick={() => doDelete(deleteConfirm.def)}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete anyway'}
              </button>
              <button className={styles.cancelBtn} onClick={() => setDeleteConfirm(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Add field */}
      {!showForm ? (
        <button className={styles.addBtn} onClick={() => setShowForm(true)}>
          + Add Field
        </button>
      ) : (
        <div className={styles.form}>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Label</label>
            <input
              className={styles.formInput}
              value={form.label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="e.g. Fund Vintage"
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Key</label>
            <input
              className={styles.formInput}
              value={form.fieldKey}
              onChange={(e) => setForm({ ...form, fieldKey: e.target.value })}
              placeholder="e.g. fund_vintage"
            />
          </div>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Type</label>
            <select
              className={styles.formSelect}
              value={form.fieldType}
              onChange={(e) => setForm({ ...form, fieldType: e.target.value as CustomFieldType })}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          {(form.fieldType === 'select' || form.fieldType === 'multiselect') && (
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Options (JSON)</label>
              <input
                className={styles.formInput}
                value={form.optionsJson}
                onChange={(e) => setForm({ ...form, optionsJson: e.target.value })}
                placeholder='["Option A", "Option B"]'
              />
            </div>
          )}
          <div className={styles.formCheckboxRow}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={form.isRequired}
                onChange={(e) => setForm({ ...form, isRequired: e.target.checked })}
              />
              Required
            </label>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={form.showInList}
                onChange={(e) => setForm({ ...form, showInList: e.target.checked })}
              />
              Show in list
            </label>
          </div>
          {formError && <div className={styles.formError}>{formError}</div>}
          <div className={styles.formActions}>
            <button className={styles.saveBtn} onClick={handleCreate} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className={styles.cancelBtn} onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setFormError(null) }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
