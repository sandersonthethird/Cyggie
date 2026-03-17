import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCustomFieldSection } from '../../hooks/useCustomFieldSection'
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
import { CustomFieldsPanel } from '../crm/CustomFieldsPanel'
import { CreateCustomFieldModal } from '../crm/CreateCustomFieldModal'
import { ChipSelect } from '../crm/ChipSelect'
import { SummaryConfigPopover } from '../crm/SummaryConfigPopover'
import { SocialsEditor } from '../crm/SocialsEditor'
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

function SectionHeader({ title }: { title: string }) {
  return <div className={styles.sectionHeader}>{title}</div>
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
  const [showConfig, setShowConfig] = useState(false)
  const [customFields, setCustomFields] = useState<CustomFieldWithValue[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [createFieldOpen, setCreateFieldOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const firstNameInputRef = useRef<HTMLInputElement>(null)

  const { getJSON, setJSON } = usePreferencesStore()
  const { contactDefs, refresh } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:contact-summary-fields', [])
  const pinnedFieldKeys = getJSON<string[]>('cyggie:contact-pinned-fields', [])
  const hiddenFields = getJSON<string[]>('cyggie:contact-hidden-fields', [])

  const contactTypeDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === 'contactType')
  const contactTypeOptions = mergeBuiltinOptions(CONTACT_TYPES, contactTypeDef?.optionsJson ?? null)

  function togglePinnedKey(key: string) {
    const next = pinnedKeys.includes(key)
      ? pinnedKeys.filter((k) => k !== key)
      : [...pinnedKeys, key]
    setJSON('cyggie:contact-summary-fields', next)
  }

  function togglePinnedField(key: string) {
    const next = pinnedFieldKeys.includes(key)
      ? pinnedFieldKeys.filter((k) => k !== key)
      : [...pinnedFieldKeys, key]
    setJSON('cyggie:contact-pinned-fields', next)
  }

  const { draggingFieldId, setDraggingFieldId, dragOverSection, sectionedFields, handleFieldDrop, sectionDragProps } =
    useCustomFieldSection('contact', contact.id, customFields, setCustomFields)

  // One-time migration: copy custom: keys from summary-fields → pinned-fields if pinned-fields is empty
  useEffect(() => {
    if (pinnedFieldKeys.length === 0) {
      const customKeys = pinnedKeys.filter(k => k.startsWith('custom:'))
      if (customKeys.length > 0) {
        setJSON('cyggie:contact-pinned-fields', customKeys)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pinnedCustomFields = pinnedFieldKeys
    .filter(k => k.startsWith('custom:'))
    .map(key => customFields.find(f => f.id === key.slice(7)) ?? null)
    .filter((f): f is NonNullable<typeof f> => f !== null)

  async function handlePinnedFieldSave(field: (typeof pinnedCustomFields)[0], newValue: string | number | boolean | null) {
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

  function getPinnedFieldValue(field: (typeof pinnedCustomFields)[0]): string | number | boolean | null {
    if (!field.value) return null
    switch (field.fieldType) {
      case 'number': case 'currency': return field.value.valueNumber
      case 'boolean': return field.value.valueBoolean
      case 'date': return field.value.valueDate
      case 'contact_ref': case 'company_ref': return field.value.valueRefId
      default: return field.value.valueText
    }
  }

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
    return sectionedFields(sectionKey).map((field) => (
      <div
        key={field.id}
        className={styles.sectionedFieldRow}
        draggable={isEditing}
        onDragStart={() => setDraggingFieldId(field.id)}
        onDragEnd={() => setDraggingFieldId(null)}
      >
        {isEditing && <span className={styles.dragHandle}>⠿</span>}
        <PropertyRow
          label={field.label}
          value={getPinnedFieldValue(field)}
          type={field.fieldType as import('../crm/PropertyRow').PropertyRowType}
          options={opts(field)}
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
      </div>
    ))
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

  const hasHiddenFields = !isEditing && !showAllFields && (
    hiddenFields.length > 0 ||
    !contact.phone || !contact.linkedinUrl || !contact.twitterHandle ||
    !contact.city || !contact.state || !contact.timezone ||
    !contact.previousCompanies || !contact.university || !contact.tags || !contact.pronouns
  )

  return (
    <div className={styles.panel}>
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
          <div className={styles.headerBadge}>
            <ChipSelect
              value={contact.contactType ?? ''}
              options={[{ value: '', label: '—' }, ...contactTypeOptions]}
              isEditing={isEditing}
              onSave={(v) => save('contactType', v || null)}
              className={`${styles.badge} ${contact.contactType ? (CONTACT_TYPE_STYLE[contact.contactType] ?? '') : ''}`}
              allowEmpty={true}
              onAddOption={contactTypeDef ? async (opt) => addCustomFieldOption(contactTypeDef.id, contactTypeDef.optionsJson, opt) : undefined}
            />
            {pinnedKeys.map((key) => renderPinnedChip(key))}
            <div className={styles.configureWrap}>
              <button
                className={styles.configureBtn}
                title="Configure summary"
                onClick={() => setShowConfig((s) => !s)}
              >
                ⊕
              </button>
              {showConfig && (
                <SummaryConfigPopover
                  pinnedKeys={pinnedKeys}
                  onToggle={togglePinnedKey}
                  columnDefs={CONTACT_COLUMN_DEFS}
                  customDefs={contactDefs}
                  entityData={contact as Record<string, unknown>}
                  customFields={customFields}
                  headerKeys={CONTACT_HEADER_KEYS}
                  onClose={() => setShowConfig(false)}
                />
              )}
            </div>
            <LastTouchBadge lastTouchpoint={lastTouchpoint ?? contact.lastTouchpoint} />
          </div>
        </div>
        {isEditing ? (
          <button className={styles.doneBtn} onClick={handleDone}>Done</button>
        ) : (
          <button className={styles.editBtn} onClick={() => setIsEditing(true)}>Edit</button>
        )}
      </div>

      {pinnedCustomFields.length > 0 && (
        <>
          <SectionHeader title="Pinned" />
          {pinnedCustomFields.map((field) => {
            const opts = field.optionsJson ? (() => { try { return JSON.parse(field.optionsJson!) } catch { return [] } })() : []
            return (
              <PropertyRow
                key={field.id}
                label={field.label}
                value={getPinnedFieldValue(field)}
                type={field.fieldType as PropertyRowType}
                options={opts}
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
            )
          })}
        </>
      )}

      <div {...sectionDragProps('contact_info')} className={dragOverSection === 'contact_info' ? styles.dropTarget : ''}>
        <SectionHeader title="Contact Info" />
        {contact.emails.map((email) => (
          <div key={email} className={styles.emailRow}>
            <span className={styles.emailValue}>{email}</span>
            <button className={styles.copyBtn} onClick={() => copyEmail(email)} title="Copy email">⎘</button>
          </div>
        ))}
        {showField('phone', contact.phone) && (
          <HideableRow fieldKey="phone">
            <div className={styles.propertyWithBadge}>
              <PropertyRow label="Phone" value={contact.phone} type="text" editMode={isEditing} onSave={(v) => save('phone', v)} />
              {fieldSources?.phone && (
                <span className={styles.sourceBadge} title={`From: ${fieldSources.phone.meetingTitle}`}>📋</span>
              )}
            </div>
          </HideableRow>
        )}
        {showField('linkedinUrl', contact.linkedinUrl) && (
          <HideableRow fieldKey="linkedinUrl">
            <div className={styles.propertyWithBadge}>
              <PropertyRow label="LinkedIn" value={contact.linkedinUrl} type="url" editMode={isEditing} onSave={(v) => save('linkedinUrl', v)} />
              {fieldSources?.linkedinUrl && (
                <span className={styles.sourceBadge} title={`From: ${fieldSources.linkedinUrl.meetingTitle}`}>📋</span>
              )}
            </div>
          </HideableRow>
        )}
        {showField('twitterHandle', contact.twitterHandle) && (
          <HideableRow fieldKey="twitterHandle">
            <PropertyRow label="Twitter/X" value={contact.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />
          </HideableRow>
        )}
        {showField('city', contact.city) && (
          <HideableRow fieldKey="city">
            <PropertyRow label="City" value={contact.city} type="text" editMode={isEditing} onSave={(v) => save('city', v)} />
          </HideableRow>
        )}
        {showField('state', contact.state) && (
          <HideableRow fieldKey="state">
            <PropertyRow label="State" value={contact.state} type="text" editMode={isEditing} onSave={(v) => save('state', v)} />
          </HideableRow>
        )}
        {showField('timezone', contact.timezone) && (
          <HideableRow fieldKey="timezone">
            <PropertyRow label="Timezone" value={contact.timezone} type="text" editMode={isEditing} onSave={(v) => save('timezone', v)} />
          </HideableRow>
        )}
        {renderSectionedFields('contact_info')}
      </div>

      <div {...sectionDragProps('professional')} className={dragOverSection === 'professional' ? styles.dropTarget : ''}>
        <SectionHeader title="Professional" />
        {showField('previousCompanies', contact.previousCompanies) && (
          <HideableRow fieldKey="previousCompanies">
            <PropertyRow label="Previous Companies" value={contact.previousCompanies} type="text" editMode={isEditing} onSave={(v) => save('previousCompanies', v)} />
          </HideableRow>
        )}
        {showField('university', contact.university) && (
          <HideableRow fieldKey="university">
            <PropertyRow label="University" value={contact.university} type="text" editMode={isEditing} onSave={(v) => save('university', v)} />
          </HideableRow>
        )}
        {showField('tags', contact.tags) && (
          <HideableRow fieldKey="tags">
            <PropertyRow label="Tags" value={contact.tags} type="tags" editMode={isEditing} onSave={(v) => save('tags', v)} />
          </HideableRow>
        )}
        {showField('pronouns', contact.pronouns) && (
          <HideableRow fieldKey="pronouns">
            <PropertyRow label="Pronouns" value={contact.pronouns} type="text" editMode={isEditing} onSave={(v) => save('pronouns', v)} />
          </HideableRow>
        )}
        {renderSectionedFields('professional')}
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

      <div {...sectionDragProps('relationship')} className={dragOverSection === 'relationship' ? styles.dropTarget : ''}>
        <SectionHeader title="Relationship" />
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
        {showField('lastMetEvent', contact.lastMetEvent) && (
          <HideableRow fieldKey="lastMetEvent">
            <PropertyRow label="Last Met At" value={contact.lastMetEvent} type="text" editMode={isEditing} onSave={(v) => save('lastMetEvent', v)} />
          </HideableRow>
        )}
        {showField('warmIntroPath', contact.warmIntroPath) && (
          <HideableRow fieldKey="warmIntroPath">
            <PropertyRow label="Warm Intro Path" value={contact.warmIntroPath} type="textarea" editMode={isEditing} onSave={(v) => save('warmIntroPath', v)} />
          </HideableRow>
        )}
        {showField('notes', contact.notes) && (
          <HideableRow fieldKey="notes">
            <PropertyRow label="Notes" value={contact.notes} type="textarea" editMode={isEditing} onSave={(v) => save('notes', v)} />
          </HideableRow>
        )}
        {renderSectionedFields('relationship')}
      </div>

      {(contact.contactType === 'investor' || sectionedFields('investor_info').length > 0) && (
        <div {...sectionDragProps('investor_info')} className={dragOverSection === 'investor_info' ? styles.dropTarget : ''}>
          <SectionHeader title="Investor Info" />
          {contact.contactType === 'investor' && (
            <>
              {showField('fundSize', contact.fundSize) && (
                <HideableRow fieldKey="fundSize">
                  <PropertyRow label="Fund Size" value={contact.fundSize} type="currency" editMode={isEditing} onSave={(v) => save('fundSize', v)} />
                </HideableRow>
              )}
              {showField('typicalCheckSizeMin', contact.typicalCheckSizeMin) && (
                <HideableRow fieldKey="typicalCheckSizeMin">
                  <PropertyRow label="Check Size Min" value={contact.typicalCheckSizeMin} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMin', v)} />
                </HideableRow>
              )}
              {showField('typicalCheckSizeMax', contact.typicalCheckSizeMax) && (
                <HideableRow fieldKey="typicalCheckSizeMax">
                  <PropertyRow label="Check Size Max" value={contact.typicalCheckSizeMax} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMax', v)} />
                </HideableRow>
              )}
              {showField('investmentStageFocus', contact.investmentStageFocus) && (
                <HideableRow fieldKey="investmentStageFocus">
                  <PropertyRow label="Stage Focus" value={contact.investmentStageFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentStageFocus', v)} />
                </HideableRow>
              )}
              {showField('investmentSectorFocus', contact.investmentSectorFocus) && (
                <HideableRow fieldKey="investmentSectorFocus">
                  <PropertyRow label="Sector Focus" value={contact.investmentSectorFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentSectorFocus', v)} />
                </HideableRow>
              )}
              {showField('investorStage', contact.investorStage) && (
                <HideableRow fieldKey="investorStage">
                  <PropertyRow label="Investor Stage" value={contact.investorStage} type="text" editMode={isEditing} onSave={(v) => save('investorStage', v)} />
                </HideableRow>
              )}
              {showField('proudPortfolioCompanies', contact.proudPortfolioCompanies) && (
                <HideableRow fieldKey="proudPortfolioCompanies">
                  <PropertyRow label="Portfolio Cos" value={contact.proudPortfolioCompanies} type="text" editMode={isEditing} onSave={(v) => save('proudPortfolioCompanies', v)} />
                </HideableRow>
              )}
            </>
          )}
          {renderSectionedFields('investor_info')}
        </div>
      )}

      {hasHiddenFields && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(true)}>
          Show all fields
        </button>
      )}
      {showAllFields && !isEditing && (
        <button className={styles.showAllBtn} onClick={() => setShowAllFields(false)}>
          Hide empty fields
        </button>
      )}

      <CustomFieldsPanel
        entityType="contact"
        entityId={contact.id}
        onFieldsLoaded={setCustomFields}
        onCreateField={() => setCreateFieldOpen(true)}
        draggingFieldId={draggingFieldId}
        onDropToUnsectioned={() => handleFieldDrop(null)}
      />

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="contact"
          onSaved={() => { void refresh().then(() => setCreateFieldOpen(false)) }}
          onClose={() => setCreateFieldOpen(false)}
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
