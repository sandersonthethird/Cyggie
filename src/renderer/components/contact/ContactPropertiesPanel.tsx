import { useEffect, useRef, useState, type ReactNode, type HTMLAttributes } from 'react'
import { useCustomFieldSection } from '../../hooks/useCustomFieldSection'
import { useHeaderChipOrder } from '../../hooks/useHeaderChipOrder'
import { useHardcodedFieldOrder } from '../../hooks/useHardcodedFieldOrder'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactDetail } from '../../../shared/types/contact'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import ConfirmDialog from '../common/ConfirmDialog'
import { daysSince, formatCurrency, formatDate } from '../../utils/format'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { PropertyRow, type PropertyRowType } from '../crm/PropertyRow'
import { chipStyle } from '../../utils/colorChip'
import { CreateCustomFieldModal } from '../crm/CreateCustomFieldModal'
import { ChipSelect } from '../crm/ChipSelect'
import { SocialsEditor } from '../crm/SocialsEditor'
import { computeChipDelta } from '../../utils/chip-delta'
import { usePinnedMigration } from '../../hooks/usePinnedMigration'
import { ContactAvatar } from '../crm/ContactAvatar'
import {
  CONTACT_TYPES,
  CONTACT_COLUMN_DEFS,
  CONTACT_HEADER_KEYS
} from './contactColumns'
import styles from './ContactPropertiesPanel.module.css'
import { api } from '../../api'

const CONTACT_TYPE_STYLE: Record<string, string> = {
  investor: styles.chipInvestor,
  founder: styles.chipFounder,
  operator: styles.chipOperator,
}

interface ContactPropertiesPanelProps {
  contact: ContactDetail
  lastTouchpoint?: string | null
  onUpdate: (updates: Record<string, unknown>) => void
  showEnrichBanner?: boolean
  enrichMeetingCount?: number
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>
  onEnrichFromMeetings?: () => void
  isLoadingEnrich?: boolean
}

function LastTouchBadge({ lastTouchpoint }: { lastTouchpoint: string | null | undefined }) {
  const days = daysSince(lastTouchpoint ?? null)
  if (days == null) return <span className={`${styles.touchBadge} ${styles.touchNone}`}>No contact</span>
  if (days <= 7) return <span className={`${styles.touchBadge} ${styles.touchGreen}`}>{days}d ago</span>
  if (days <= 30) return <span className={`${styles.touchBadge} ${styles.touchYellow}`}>{days}d ago</span>
  return <span className={`${styles.touchBadge} ${styles.touchRed}`}>{days}d ago</span>
}

function SectionHeader({
  title,
  collapsible,
  isCollapsed,
  onToggle,
}: {
  title: string
  collapsible?: boolean
  isCollapsed?: boolean
  onToggle?: () => void
}) {
  return (
    <div className={styles.sectionHeader}>
      {title}
      {collapsible && (
        <button
          className={styles.sectionCollapseBtn}
          onClick={onToggle}
          title={isCollapsed ? 'Expand section' : 'Collapse section'}
        >
          {isCollapsed ? '▶' : '▼'}
        </button>
      )}
    </div>
  )
}

function formatPinnedValue(value: unknown, type: string, options?: { value: string; label: string }[]): string | null {
  if (value == null || value === '') return null
  if (options) {
    const opt = options.find((o) => o.value === String(value))
    if (opt) return opt.label
  }
  switch (type) {
    case 'currency': return formatCurrency(Number(value))
    case 'date': return formatDate(String(value))
    default: return String(value)
  }
}

export function ContactPropertiesPanel({
  contact,
  lastTouchpoint,
  onUpdate,
  showEnrichBanner,
  enrichMeetingCount,
  fieldSources,
  onEnrichFromMeetings,
  isLoadingEnrich
}: ContactPropertiesPanelProps) {
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [firstNameDraft, setFirstNameDraft] = useState(contact.firstName ?? '')
  const [lastNameDraft, setLastNameDraft] = useState(contact.lastName ?? '')
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [createFieldOpen, setCreateFieldOpen] = useState(false)
  const [createFieldSection, setCreateFieldSection] = useState<string | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null)
  const [editingFieldLabel, setEditingFieldLabel] = useState('')
  const firstNameInputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const { getJSON, setJSON } = usePreferencesStore()
  const { contactDefs, refresh, loaded: defsLoaded, load: loadDefs, version: defsVersion } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:contact-summary-fields', [])
  const hiddenFields = getJSON<string[]>('cyggie:contact-hidden-fields', [])
  const hiddenHeaderChips = getJSON<string[]>('cyggie:contact-hidden-header-chips', [])

  const contactTypeDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === 'contactType')
  const contactTypeOptions = mergeBuiltinOptions(CONTACT_TYPES, contactTypeDef?.optionsJson ?? null)

  // Per-entity collapsed sections (Change 10)
  const collapsedSectionsKey = `cyggie:contact-collapsed:${contact.id}`
  const collapsedSections = getJSON<string[]>(collapsedSectionsKey, [])
  function isCollapsed(key: string) { return collapsedSections.includes(key) }
  function toggleSection(key: string) {
    const next = collapsedSections.includes(key)
      ? collapsedSections.filter((k) => k !== key)
      : [...collapsedSections, key]
    setJSON(collapsedSectionsKey, next)
  }

  function togglePinnedKey(key: string, force?: boolean) {
    const next = force === true
      ? (pinnedKeys.includes(key) ? pinnedKeys : [...pinnedKeys, key])
      : force === false
        ? pinnedKeys.filter((k) => k !== key)
        : (pinnedKeys.includes(key) ? pinnedKeys.filter((k) => k !== key) : [...pinnedKeys, key])
    setJSON('cyggie:contact-summary-fields', next)
  }

  function hideHeaderChip(key: string) {
    if (!hiddenHeaderChips.includes(key)) {
      setJSON('cyggie:contact-hidden-header-chips', [...hiddenHeaderChips, key])
    }
  }

  function restoreHeaderChip(key: string) {
    setJSON('cyggie:contact-hidden-header-chips', hiddenHeaderChips.filter(k => k !== key))
  }

  const { draggingFieldId, setDraggingFieldId, dragOverSection, draggingOverFieldId, setDraggingOverFieldId, sectionedFields, nullSectionFields, handleWithinSectionDrop, sectionDragProps } =
    useCustomFieldSection('contact', contact.id, customFields, setCustomFields)

  const hfOrder = useHardcodedFieldOrder('contact')

  // Deduplicate: custom fields in 'summary' section + pinned builtin keys
  const customSummaryIds = customFields.filter(f => f.section === 'summary').map(f => `custom:${f.id}`)
  const allChipIds = [...new Set(['contactType', ...pinnedKeys, ...customSummaryIds])]
  const { effectiveOrder, chipDragProps, chipDropZoneProps, chipDragOverIndex } =
    useHeaderChipOrder('contact', allChipIds)

  // Migrate old 'Pinned' section fields to 'Header' section (Change 4)
  usePinnedMigration('contact')

  async function handlePinnedFieldSave(field: CustomFieldWithValue, newValue: string | number | boolean | null) {
    if (newValue == null || newValue === '') {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_DELETE_VALUE, field.id, contact.id)
      setCustomFields(prev => prev.map(f => f.id === field.id ? { ...f, value: null } : f))
      return
    }
    const input: import('../../../shared/types/custom-fields').SetCustomFieldValueInput = {
      fieldDefinitionId: field.id,
      entityId: contact.id,
      entityType: 'contact',
    }
    switch (field.fieldType) {
      case 'number': case 'currency': input.valueNumber = Number(newValue); break
      case 'boolean': input.valueBoolean = Boolean(newValue); break
      case 'date': input.valueDate = String(newValue); break
      case 'contact_ref': case 'company_ref': input.valueRefId = String(newValue); break
      default: input.valueText = String(newValue)
    }
    await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_SET_VALUE, input)
  }

  function getPinnedFieldValue(field: CustomFieldWithValue): string | number | boolean | null {
    if (!field.value) return null
    switch (field.fieldType) {
      case 'number': case 'currency': return field.value.valueNumber
      case 'boolean': return field.value.valueBoolean
      case 'date': return field.value.valueDate
      case 'contact_ref': case 'company_ref': return field.value.valueRefId
      default: return field.value.valueText
    }
  }

  // Inline field label rename (Change 11)
  async function handleFieldLabelSave(fieldId: string, newLabel: string) {
    const trimmed = newLabel.trim()
    if (!trimmed) { setEditingFieldId(null); return }
    const prev = customFields
    setCustomFields(fs => fs.map(f => f.id === fieldId ? { ...f, label: trimmed } : f))
    setEditingFieldId(null)
    try {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, fieldId, { label: trimmed })
    } catch {
      setCustomFields(prev) // rollback on failure
    }
  }

  // Wrap sectionDragProps to also sync pinnedKeys when a field crosses the 'summary' boundary (Change 1)
  function syncedSectionDragProps(sectionKey: string): HTMLAttributes<HTMLDivElement> {
    const base = sectionDragProps(sectionKey)
    return {
      ...base,
      onDrop: (e) => {
        if (draggingFieldId) {
          const draggingField = customFields.find(f => f.id === draggingFieldId)
          const fromSection = draggingField?.section ?? null
          const chipId = `custom:${draggingFieldId}`
          const newPinnedKeys = computeChipDelta(fromSection, sectionKey, chipId, pinnedKeys)
          if (newPinnedKeys !== pinnedKeys) {
            setJSON('cyggie:contact-summary-fields', newPinnedKeys)
          }
        }
        base.onDrop?.(e)
      },
    }
  }

  useEffect(() => {
    if (!defsLoaded) loadDefs()
  }, [defsLoaded, loadDefs])

  useEffect(() => {
    if (!defsLoaded) return
    window.api
      .invoke<{ success: boolean; data?: CustomFieldWithValue[] }>(
        IPC_CHANNELS.CUSTOM_FIELD_GET_VALUES,
        'contact',
        contact.id
      )
      .then((res) => { if (res.success && res.data) setCustomFields(res.data) })
      .catch(console.error)
  }, [contact.id, defsLoaded, defsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync name drafts when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setFirstNameDraft(contact.firstName ?? '')
      setLastNameDraft(contact.lastName ?? '')
      setTimeout(() => firstNameInputRef.current?.focus(), 0)
    }
  }, [isEditing, contact.firstName, contact.lastName])

  function save(field: string, value: unknown) {
    return window.api
      .invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { [field]: value })
      .then(() => { onUpdate({ [field]: value }) })
  }

  function copyEmail(email: string) {
    navigator.clipboard.writeText(email).catch(console.error)
  }

  function handleDone() {
    const firstName = firstNameDraft.trim()
    const lastName = lastNameDraft.trim()
    const fullName = [firstName, lastName].filter(Boolean).join(' ')
    if (fullName && fullName !== contact.fullName) {
      window.api
        .invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { firstName: firstName || null, lastName: lastName || null })
        .then(() => { onUpdate({ firstName: firstName || null, lastName: lastName || null, fullName }) })
        .catch(console.error)
    }
    setIsEditing(false)
  }

  async function handleDeleteContact() {
    if (deleting) return
    setDeleting(true)
    try {
      await api.invoke(IPC_CHANNELS.CONTACT_DELETE, contact.id)
      navigate('/contacts')
    } catch (err) {
      console.error('[ContactPropertiesPanel] delete failed:', err)
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleDone()
    if (e.key === 'Escape') setIsEditing(false)
  }

  function show(value: unknown): boolean {
    if (isEditing || showAllFields) return true
    return value !== null && value !== undefined && value !== ''
  }

  function showField(key: string, value: unknown): boolean {
    if (isEditing || showAllFields) return true
    if (hiddenFields.includes(key)) return false
    return value !== null && value !== undefined && value !== ''
  }

  function hideField(key: string) {
    setJSON('cyggie:contact-hidden-fields', [...hiddenFields, key])
  }

  function restoreField(key: string) {
    setJSON('cyggie:contact-hidden-fields', hiddenFields.filter(k => k !== key))
  }

  function renderSectionedFields(sectionKey: string) {
    const opts = (field: (typeof customFields)[0]) => {
      try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] }
    }
    return sectionedFields(sectionKey).map((field) => {
      const fieldKey = `custom:${field.id}`
      if (hiddenFields.includes(fieldKey) && !isEditing && !showAllFields) return null
      const isDropTarget = draggingOverFieldId === field.id && draggingFieldId !== field.id
      return (
        <div
          key={field.id}
          className={`${styles.sectionedFieldRow} ${isDropTarget ? styles.dragOverFieldIndicator : ''}`}
          draggable={isEditing}
          onDragStart={() => setDraggingFieldId(field.id)}
          onDragEnd={() => { setDraggingFieldId(null); setDraggingOverFieldId(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && draggingOverFieldId !== field.id) setDraggingOverFieldId(field.id)
          }}
          onDrop={(e) => {
            e.stopPropagation() // prevent cross-section drop handler from also firing
            if (isEditing) handleWithinSectionDrop(field.id)
          }}
        >
          {isEditing && <span className={styles.dragHandle}>⠿</span>}
          {isEditing && editingFieldId === field.id ? (
            <input
              className={styles.inlineRenameInput}
              autoFocus
              value={editingFieldLabel}
              onChange={(e) => setEditingFieldLabel(e.target.value)}
              onBlur={() => handleFieldLabelSave(field.id, editingFieldLabel)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleFieldLabelSave(field.id, editingFieldLabel)
                if (e.key === 'Escape') setEditingFieldId(null)
              }}
            />
          ) : (
          <HideableRow fieldKey={fieldKey}>
            <PropertyRow
              label={field.label}
              value={getPinnedFieldValue(field)}
              type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
              options={opts(field)}
              editMode={isEditing}
              onSave={(val) => handlePinnedFieldSave(field, val)}
              onAddOption={
                (field.fieldType === 'select' || field.fieldType === 'multiselect')
                  ? async (newOption) => {
                      const opt = newOption.trim().slice(0, 200)
                      await addCustomFieldOption(field.id, field.optionsJson, opt)
                      setCustomFields(prev => prev.map(f => {
                        if (f.id !== field.id) return f
                        const cur: string[] = (() => { try { return JSON.parse(f.optionsJson ?? '[]') } catch { return [] } })()
                        return { ...f, optionsJson: JSON.stringify([...cur, opt]) }
                      }))
                    }
                  : undefined
              }
            />
            {isEditing && (
              <button
                className={styles.renameFieldBtn}
                title="Rename field"
                onClick={() => { setEditingFieldId(field.id); setEditingFieldLabel(field.label) }}
              >✎</button>
            )}
          </HideableRow>
          )}
        </div>
      )
    })
  }

  function renderHardcodedSection(
    fields: Array<{ key: string; visible: boolean; render: () => ReactNode }>,
    sectionKey: string
  ) {
    const ordered = hfOrder.applyOrder(fields, sectionKey)
    return ordered.map((field) => {
      if (!field.visible) return null
      const isDropTarget = hfOrder.draggingOverKey === field.key && hfOrder.draggingKey !== field.key
      return (
        <div
          key={field.key}
          className={`${styles.sectionedFieldRow} ${isDropTarget ? styles.dragOverFieldIndicator : ''}`}
          draggable={isEditing}
          onDragStart={() => hfOrder.setDraggingKey(field.key)}
          onDragEnd={() => { hfOrder.setDraggingKey(null); hfOrder.setDraggingOverKey(null) }}
          onDragOver={(e) => {
            e.preventDefault()
            if (isEditing && hfOrder.draggingOverKey !== field.key) hfOrder.setDraggingOverKey(field.key)
          }}
          onDrop={(e) => {
            e.stopPropagation()
            if (isEditing && hfOrder.draggingKey) {
              hfOrder.reorder(sectionKey, hfOrder.draggingKey, field.key, ordered.map((f) => f.key))
            }
          }}
        >
          {isEditing && <span className={styles.dragHandle}>⠿</span>}
          <div style={{ flex: 1, minWidth: 0 }}>{field.render()}</div>
        </div>
      )
    })
  }

  function HideableRow({ fieldKey, children }: { fieldKey: string; children: ReactNode }) {
    const isHidden = hiddenFields.includes(fieldKey)
    return (
      <div className={`${styles.hideable} ${isHidden ? styles.fieldHidden : ''}`}>
        <div className={styles.hideableContent}>{children}</div>
        {(showAllFields || isEditing) && (
          isHidden
            ? <button className={styles.restoreBtn} title="Restore field" onClick={() => restoreField(fieldKey)}>↺</button>
            : <button className={styles.hideBtn} title="Hide field" onClick={() => hideField(fieldKey)}>×</button>
        )}
      </div>
    )
  }

  function renderPinnedChip(key: string) {
    if (key.startsWith('custom:')) {
      const id = key.slice(7)
      const def = contactDefs.find((d) => d.id === id)
      if (!def) return null
      const fieldWithValue = customFields.find((f) => f.id === id)
      if (!fieldWithValue?.value) return null
      let display = ''
      const v = fieldWithValue.value
      switch (def.fieldType) {
        case 'currency': display = formatCurrency(v.valueNumber ?? 0); break
        case 'date': display = v.valueDate ? formatDate(v.valueDate) : ''; break
        case 'boolean': display = v.valueBoolean != null ? (v.valueBoolean ? 'Yes' : 'No') : ''; break
        case 'contact_ref':
        case 'company_ref': display = v.resolvedLabel ?? v.valueRefId ?? ''; break
        default: display = v.valueText ?? ''
      }
      if (!display) return null

      if (def.fieldType === 'multiselect') {
        const vals = display.split(',').map(s => s.trim()).filter(Boolean)
        if (vals.length === 0) return null
        return (
          <span key={key} className={styles.pinnedChips} title={def.label}>
            <span className={styles.pinnedChipLabel}>{def.label}:</span>
            {vals.map(v => (
              <span key={v} className={styles.pinnedChip} style={chipStyle(v)}>{v}</span>
            ))}
          </span>
        )
      }

      return (
        <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={def.label}>
          {def.label}: {display}
        </span>
      )
    }

    // Built-in field
    const col = CONTACT_COLUMN_DEFS.find((c) => c.key === key)
    if (!col || !col.field) return null
    const value = (contact as Record<string, unknown>)[col.field]
    const display = formatPinnedValue(value, col.type, col.options as { value: string; label: string }[] | undefined)
    if (!display) return null
    return (
      <span key={key} className={`${styles.badge} ${styles.pinnedBadge}`} title={col.label}>
        {col.label}: {display}
      </span>
    )
  }

  const CHIP_LABELS: Record<string, string> = {
    contactType: 'Type',
  }

  function renderChipById(id: string) {
    if (id === 'contactType') {
      return (
        <ChipSelect
          value={contact.contactType ?? ''}
          options={[{ value: '', label: '—' }, ...contactTypeOptions]}
          isEditing={isEditing}
          onSave={(v) => save('contactType', v || null)}
          className={`${styles.badge} ${contact.contactType ? (CONTACT_TYPE_STYLE[contact.contactType] ?? '') : ''}`}
          allowEmpty={true}
          onAddOption={contactTypeDef ? async (opt) => addCustomFieldOption(contactTypeDef.id, contactTypeDef.optionsJson, opt) : undefined}
        />
      )
    }
    return renderPinnedChip(id)
  }

  // Count of explicitly-hidden fields + empty hardcoded fields (Change 6)
  const hiddenFieldCount = !isEditing && !showAllFields ? (
    hiddenFields.length +
    ([contact.phone, contact.linkedinUrl, contact.twitterHandle, contact.city, contact.state,
      contact.timezone, contact.previousCompanies, contact.university, contact.tags, contact.pronouns]
      .filter(v => !v).length) +
    customFields.filter(f => !f.value && f.section !== 'summary').length
  ) : 0

  return (
    <div ref={panelRef} className={styles.panel}>
      {showEnrichBanner && (
        <div className={styles.enrichBanner}>
          <span>✨ Meeting data available</span>
          <button
            className={styles.enrichBannerBtn}
            onClick={onEnrichFromMeetings}
            disabled={isLoadingEnrich}
          >
            {isLoadingEnrich
              ? 'Loading…'
              : `Enrich profile (${enrichMeetingCount} meeting${enrichMeetingCount !== 1 ? 's' : ''})`
            }
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete contact?"
        message={`This will permanently delete ${contact.fullName}.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
        onConfirm={handleDeleteContact}
        onCancel={() => setConfirmDelete(false)}
      />
      {/* Header */}
      <div className={styles.header}>
        <ContactAvatar name={contact.fullName} size="lg" />
        <div className={styles.headerMeta}>
          {isEditing ? (
            <div className={styles.nameInputRow}>
              <input
                ref={firstNameInputRef}
                className={styles.nameInput}
                placeholder="First name"
                value={firstNameDraft}
                onChange={(e) => setFirstNameDraft(e.target.value)}
                onKeyDown={handleNameKeyDown}
              />
              <input
                className={styles.nameInput}
                placeholder="Last name"
                value={lastNameDraft}
                onChange={(e) => setLastNameDraft(e.target.value)}
                onKeyDown={handleNameKeyDown}
              />
            </div>
          ) : (
            <div className={styles.name}>{contact.fullName}</div>
          )}
          <div className={styles.titleAndCompany}>
            {contact.title && <span>{contact.title}</span>}
            {contact.title && fieldSources?.title && (
              <span className={styles.sourceBadge} title={`From: ${fieldSources.title.meetingTitle}`}>📋</span>
            )}
            {contact.title && contact.primaryCompany && <span className={styles.sep}>@</span>}
            {contact.primaryCompany && (
              <button
                className={styles.companyLink}
                onClick={() => navigate(`/company/${contact.primaryCompany!.id}`)}
              >
                {contact.primaryCompany.canonicalName}
              </button>
            )}
          </div>
          <div
            className={`${styles.headerBadge} ${isEditing && dragOverSection === 'summary' ? styles.dropTarget : ''}`}
            {...(isEditing ? syncedSectionDragProps('summary') : {})}
          >
            {effectiveOrder.map((id, i) => {
              const isHidden = hiddenHeaderChips.includes(id)
              if (!isEditing && isHidden) return null
              return (
                <div
                  key={id}
                  className={`${styles.headerChipDraggable} ${chipDragOverIndex === i ? styles.chipDropIndicator : ''} ${isEditing && isHidden ? styles.hiddenHeaderChip : ''}`}
                  {...chipDragProps(id)}
                  {...chipDropZoneProps(i)}
                >
                  {isEditing && isHidden ? (
                    <span className={styles.hiddenChipPlaceholder}>
                      {CHIP_LABELS[id] ?? id}
                      <button className={styles.restoreChipBtn} title="Restore chip" onClick={() => restoreHeaderChip(id)}>↺</button>
                    </span>
                  ) : (
                    <>
                      {isEditing && CHIP_LABELS[id] ? (
                        <div className={styles.editChipField}>
                          <span className={styles.editChipLabel}>{CHIP_LABELS[id]}</span>
                          {renderChipById(id)}
                        </div>
                      ) : (
                        renderChipById(id)
                      )}
                      {isEditing && (
                        <button className={styles.hideChipBtn} title="Hide chip" onClick={() => hideHeaderChip(id)}>×</button>
                      )}
                    </>
                  )}
                </div>
              )
            })}
            <LastTouchBadge lastTouchpoint={lastTouchpoint ?? contact.lastTouchpoint} />
          </div>
        </div>
        {isEditing ? (
          <button className={styles.doneBtn} onClick={handleDone}>Done</button>
        ) : (
          <button className={styles.editBtn} onClick={() => setIsEditing(true)}>Edit</button>
        )}
      </div>

      <div {...syncedSectionDragProps('contact_info')} className={isEditing && dragOverSection === 'contact_info' ? styles.dropTarget : ''}>
        <SectionHeader title="Contact Info" collapsible isCollapsed={isCollapsed('contact_info')} onToggle={() => toggleSection('contact_info')} />
        {!isCollapsed('contact_info') && (<>
        {contact.emails.map((email) => (
          <div key={email} className={styles.emailRow}>
            <span className={styles.emailValue}>{email}</span>
            <button className={styles.copyBtn} onClick={() => copyEmail(email)} title="Copy email">⎘</button>
          </div>
        ))}
        {renderHardcodedSection([
          { key: 'phone', visible: showField('phone', contact.phone), render: () => (
            <HideableRow fieldKey="phone">
              <div className={styles.propertyWithBadge}>
                <PropertyRow label="Phone" value={contact.phone} type="text" editMode={isEditing} onSave={(v) => save('phone', v)} />
                {fieldSources?.phone && <span className={styles.sourceBadge} title={`From: ${fieldSources.phone.meetingTitle}`}>📋</span>}
              </div>
            </HideableRow>
          )},
          { key: 'linkedinUrl', visible: showField('linkedinUrl', contact.linkedinUrl), render: () => (
            <HideableRow fieldKey="linkedinUrl">
              <div className={styles.propertyWithBadge}>
                <PropertyRow label="LinkedIn" value={contact.linkedinUrl} type="url" editMode={isEditing} onSave={(v) => save('linkedinUrl', v)} />
                {fieldSources?.linkedinUrl && <span className={styles.sourceBadge} title={`From: ${fieldSources.linkedinUrl.meetingTitle}`}>📋</span>}
              </div>
            </HideableRow>
          )},
          { key: 'twitterHandle', visible: showField('twitterHandle', contact.twitterHandle), render: () => (
            <HideableRow fieldKey="twitterHandle">
              <PropertyRow label="Twitter/X" value={contact.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />
            </HideableRow>
          )},
          { key: 'city', visible: showField('city', contact.city), render: () => (
            <HideableRow fieldKey="city">
              <PropertyRow label="City" value={contact.city} type="text" editMode={isEditing} onSave={(v) => save('city', v)} />
            </HideableRow>
          )},
          { key: 'state', visible: showField('state', contact.state), render: () => (
            <HideableRow fieldKey="state">
              <PropertyRow label="State" value={contact.state} type="text" editMode={isEditing} onSave={(v) => save('state', v)} />
            </HideableRow>
          )},
          { key: 'timezone', visible: showField('timezone', contact.timezone), render: () => (
            <HideableRow fieldKey="timezone">
              <PropertyRow label="Timezone" value={contact.timezone} type="text" editMode={isEditing} onSave={(v) => save('timezone', v)} />
            </HideableRow>
          )},
        ], 'contact_info')}
        {renderSectionedFields('contact_info')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('contact_info'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        {nullSectionFields().map((field) => {
          const opts = (() => { try { return field.optionsJson ? JSON.parse(field.optionsJson) : [] } catch { return [] } })()
          return (
            <div
              key={field.id}
              className={styles.sectionedFieldRow}
              title="No section assigned — drag to reassign"
              draggable={isEditing}
              onDragStart={() => setDraggingFieldId(field.id)}
              onDragEnd={() => setDraggingFieldId(null)}
            >
              {isEditing && <span className={styles.dragHandle}>⠿</span>}
              <PropertyRow
                label={field.label}
                value={getPinnedFieldValue(field)}
                type={field.fieldType as PropertyRowType}
                options={opts}
                editMode={isEditing}
                onSave={(val) => handlePinnedFieldSave(field, val)}
              />
            </div>
          )
        })}
        </>)}
      </div>

      <div {...syncedSectionDragProps('professional')} className={isEditing && dragOverSection === 'professional' ? styles.dropTarget : ''}>
        <SectionHeader title="Professional" collapsible isCollapsed={isCollapsed('professional')} onToggle={() => toggleSection('professional')} />
        {!isCollapsed('professional') && (<>
        {renderHardcodedSection([
          { key: 'previousCompanies', visible: showField('previousCompanies', contact.previousCompanies), render: () => (
            <HideableRow fieldKey="previousCompanies">
              <PropertyRow label="Previous Companies" value={contact.previousCompanies} type="text" editMode={isEditing} onSave={(v) => save('previousCompanies', v)} />
            </HideableRow>
          )},
          { key: 'university', visible: showField('university', contact.university), render: () => (
            <HideableRow fieldKey="university">
              <PropertyRow label="University" value={contact.university} type="text" editMode={isEditing} onSave={(v) => save('university', v)} />
            </HideableRow>
          )},
          { key: 'tags', visible: showField('tags', contact.tags), render: () => (
            <HideableRow fieldKey="tags">
              <PropertyRow label="Tags" value={contact.tags} type="tags" editMode={isEditing} onSave={(v) => save('tags', v)} />
            </HideableRow>
          )},
          { key: 'pronouns', visible: showField('pronouns', contact.pronouns), render: () => (
            <HideableRow fieldKey="pronouns">
              <PropertyRow label="Pronouns" value={contact.pronouns} type="text" editMode={isEditing} onSave={(v) => save('pronouns', v)} />
            </HideableRow>
          )},
        ], 'professional')}
        {renderSectionedFields('professional')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('professional'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        </>)}
      </div>

      {(isEditing || contact.otherSocials) && (
        <>
          <div className={styles.socialsLabel}>Other Socials</div>
          <SocialsEditor
            value={contact.otherSocials}
            onSave={(json) => save('otherSocials', json)}
          />
        </>
      )}

      <div {...syncedSectionDragProps('relationship')} className={isEditing && dragOverSection === 'relationship' ? styles.dropTarget : ''}>
        <SectionHeader title="Relationship" collapsible isCollapsed={isCollapsed('relationship')} onToggle={() => toggleSection('relationship')} />
        {!isCollapsed('relationship') && (<>
        <div className={styles.strengthRow}>
          <span className={styles.strengthLabel}>Strength</span>
          <div className={styles.segmented}>
            {(['cold', 'warm', 'hot'] as const).map((s) => (
              <button
                key={s}
                className={`${styles.segmentBtn} ${contact.relationshipStrength === s ? styles[s] : ''}`}
                onClick={() => save('relationshipStrength', s)}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {renderHardcodedSection([
          { key: 'lastMetEvent', visible: showField('lastMetEvent', contact.lastMetEvent), render: () => (
            <HideableRow fieldKey="lastMetEvent">
              <PropertyRow label="Last Met At" value={contact.lastMetEvent} type="text" editMode={isEditing} onSave={(v) => save('lastMetEvent', v)} />
            </HideableRow>
          )},
          { key: 'warmIntroPath', visible: showField('warmIntroPath', contact.warmIntroPath), render: () => (
            <HideableRow fieldKey="warmIntroPath">
              <PropertyRow label="Warm Intro Path" value={contact.warmIntroPath} type="textarea" editMode={isEditing} onSave={(v) => save('warmIntroPath', v)} />
            </HideableRow>
          )},
          { key: 'notes', visible: showField('notes', contact.notes), render: () => (
            <HideableRow fieldKey="notes">
              <PropertyRow label="Notes" value={contact.notes} type="textarea" editMode={isEditing} onSave={(v) => save('notes', v)} />
            </HideableRow>
          )},
        ], 'relationship')}
        {renderSectionedFields('relationship')}
        {isEditing && (
          <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('relationship'); setCreateFieldOpen(true) }}>+ Add field</button>
        )}
        </>)}
      </div>

      {(contact.contactType === 'investor' || sectionedFields('investor_info').length > 0) && (
        <div {...syncedSectionDragProps('investor_info')} className={isEditing && dragOverSection === 'investor_info' ? styles.dropTarget : ''}>
          <SectionHeader title="Investor Info" collapsible isCollapsed={isCollapsed('investor_info')} onToggle={() => toggleSection('investor_info')} />
          {!isCollapsed('investor_info') && (<>
          {contact.contactType === 'investor' && renderHardcodedSection([
            { key: 'fundSize', visible: showField('fundSize', contact.fundSize), render: () => (
              <HideableRow fieldKey="fundSize">
                <PropertyRow label="Fund Size" value={contact.fundSize} type="currency" editMode={isEditing} onSave={(v) => save('fundSize', v)} />
              </HideableRow>
            )},
            { key: 'typicalCheckSizeMin', visible: showField('typicalCheckSizeMin', contact.typicalCheckSizeMin), render: () => (
              <HideableRow fieldKey="typicalCheckSizeMin">
                <PropertyRow label="Check Size Min" value={contact.typicalCheckSizeMin} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMin', v)} />
              </HideableRow>
            )},
            { key: 'typicalCheckSizeMax', visible: showField('typicalCheckSizeMax', contact.typicalCheckSizeMax), render: () => (
              <HideableRow fieldKey="typicalCheckSizeMax">
                <PropertyRow label="Check Size Max" value={contact.typicalCheckSizeMax} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMax', v)} />
              </HideableRow>
            )},
            { key: 'investmentStageFocus', visible: showField('investmentStageFocus', contact.investmentStageFocus), render: () => (
              <HideableRow fieldKey="investmentStageFocus">
                <PropertyRow label="Stage Focus" value={contact.investmentStageFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentStageFocus', v)} />
              </HideableRow>
            )},
            { key: 'investmentSectorFocus', visible: showField('investmentSectorFocus', contact.investmentSectorFocus), render: () => (
              <HideableRow fieldKey="investmentSectorFocus">
                <PropertyRow label="Sector Focus" value={contact.investmentSectorFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentSectorFocus', v)} />
              </HideableRow>
            )},
            { key: 'investorStage', visible: showField('investorStage', contact.investorStage), render: () => (
              <HideableRow fieldKey="investorStage">
                <PropertyRow label="Investor Stage" value={contact.investorStage} type="text" editMode={isEditing} onSave={(v) => save('investorStage', v)} />
              </HideableRow>
            )},
            { key: 'proudPortfolioCompanies', visible: showField('proudPortfolioCompanies', contact.proudPortfolioCompanies), render: () => (
              <HideableRow fieldKey="proudPortfolioCompanies">
                <PropertyRow label="Portfolio Cos" value={contact.proudPortfolioCompanies} type="text" editMode={isEditing} onSave={(v) => save('proudPortfolioCompanies', v)} />
              </HideableRow>
            )},
          ], 'investor_info')}
          {renderSectionedFields('investor_info')}
          {isEditing && (
            <button className={styles.addFieldBtn} onClick={() => { setCreateFieldSection('investor_info'); setCreateFieldOpen(true) }}>+ Add field</button>
          )}
          </>)}
        </div>
      )}

      {hiddenFieldCount > 0 && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(true)}>
          {hiddenFieldCount} field{hiddenFieldCount !== 1 ? 's' : ''} hidden · Show
        </button>
      )}
      {showAllFields && !isEditing && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(false)}>
          Hide empty fields
        </button>
      )}

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="contact"
          defaultSection={createFieldSection}
          onSaved={(def) => {
            void refresh().then(() => {
              setCreateFieldOpen(false)
              setCreateFieldSection(undefined)
              // Auto-add to pinnedKeys if created in Header section
              if (def.section === 'summary') {
                togglePinnedKey(`custom:${def.id}`, true)
              }
            })
          }}
          onClose={() => { setCreateFieldOpen(false); setCreateFieldSection(undefined) }}
        />
      )}

      {isEditing && (
        <div className={styles.deleteSection}>
          <button
            className={styles.deleteBtn}
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
          >
            Delete Contact
          </button>
        </div>
      )}
    </div>
  )
}
