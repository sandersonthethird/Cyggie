import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactDetail } from '../../../shared/types/contact'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import ConfirmDialog from '../common/ConfirmDialog'
import { daysSince, formatCurrency, formatDate } from '../../utils/format'
import { usePreferencesStore } from '../../stores/preferences.store'
import { useCustomFieldStore } from '../../stores/custom-fields.store'
import { addCustomFieldOption, mergeBuiltinOptions } from '../../utils/customFieldUtils'
import { PropertyRow } from '../crm/PropertyRow'
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

export function ContactPropertiesPanel({ contact, lastTouchpoint, onUpdate }: ContactPropertiesPanelProps) {
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
  const { contactDefs } = useCustomFieldStore()
  const pinnedKeys = getJSON<string[]>('cyggie:contact-summary-fields', [])

  const contactTypeDef = contactDefs.find(d => d.isBuiltin && d.fieldKey === 'contactType')
  const contactTypeOptions = mergeBuiltinOptions(CONTACT_TYPES, contactTypeDef?.optionsJson ?? null)

  function togglePinnedKey(key: string) {
    const next = pinnedKeys.includes(key)
      ? pinnedKeys.filter((k) => k !== key)
      : [...pinnedKeys, key]
    setJSON('cyggie:contact-summary-fields', next)
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
    !contact.phone || !contact.linkedinUrl || !contact.twitterHandle ||
    !contact.city || !contact.state || !contact.timezone ||
    !contact.previousCompanies || !contact.university || !contact.tags || !contact.pronouns
  )

  return (
    <div className={styles.panel}>
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

      <SectionHeader title="Contact Info" />
      {contact.emails.map((email) => (
        <div key={email} className={styles.emailRow}>
          <span className={styles.emailValue}>{email}</span>
          <button className={styles.copyBtn} onClick={() => copyEmail(email)} title="Copy email">⎘</button>
        </div>
      ))}
      {show(contact.phone) && <PropertyRow label="Phone" value={contact.phone} type="text" editMode={isEditing} onSave={(v) => save('phone', v)} />}
      {show(contact.linkedinUrl) && <PropertyRow label="LinkedIn" value={contact.linkedinUrl} type="url" editMode={isEditing} onSave={(v) => save('linkedinUrl', v)} />}
      {show(contact.twitterHandle) && <PropertyRow label="Twitter/X" value={contact.twitterHandle} type="text" editMode={isEditing} onSave={(v) => save('twitterHandle', v)} />}
      {show(contact.city) && <PropertyRow label="City" value={contact.city} type="text" editMode={isEditing} onSave={(v) => save('city', v)} />}
      {show(contact.state) && <PropertyRow label="State" value={contact.state} type="text" editMode={isEditing} onSave={(v) => save('state', v)} />}
      {show(contact.timezone) && <PropertyRow label="Timezone" value={contact.timezone} type="text" editMode={isEditing} onSave={(v) => save('timezone', v)} />}

      <SectionHeader title="Professional" />
      {show(contact.previousCompanies) && <PropertyRow label="Previous Companies" value={contact.previousCompanies} type="text" editMode={isEditing} onSave={(v) => save('previousCompanies', v)} />}
      {show(contact.university) && <PropertyRow label="University" value={contact.university} type="text" editMode={isEditing} onSave={(v) => save('university', v)} />}
      {show(contact.tags) && <PropertyRow label="Tags" value={contact.tags} type="tags" editMode={isEditing} onSave={(v) => save('tags', v)} />}
      {show(contact.pronouns) && <PropertyRow label="Pronouns" value={contact.pronouns} type="text" editMode={isEditing} onSave={(v) => save('pronouns', v)} />}

      {(isEditing || contact.otherSocials) && (
        <>
          <div className={styles.socialsLabel}>Other Socials</div>
          <SocialsEditor
            value={contact.otherSocials}
            onSave={(json) => save('otherSocials', json)}
          />
        </>
      )}

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
      {show(contact.lastMetEvent) && <PropertyRow label="Last Met At" value={contact.lastMetEvent} type="text" editMode={isEditing} onSave={(v) => save('lastMetEvent', v)} />}
      {show(contact.warmIntroPath) && <PropertyRow label="Warm Intro Path" value={contact.warmIntroPath} type="textarea" editMode={isEditing} onSave={(v) => save('warmIntroPath', v)} />}
      {show(contact.notes) && <PropertyRow label="Notes" value={contact.notes} type="textarea" editMode={isEditing} onSave={(v) => save('notes', v)} />}

      {contact.contactType === 'investor' && (
        <>
          <SectionHeader title="Investor Info" />
          {show(contact.fundSize) && <PropertyRow label="Fund Size" value={contact.fundSize} type="currency" editMode={isEditing} onSave={(v) => save('fundSize', v)} />}
          {show(contact.typicalCheckSizeMin) && <PropertyRow label="Check Size Min" value={contact.typicalCheckSizeMin} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMin', v)} />}
          {show(contact.typicalCheckSizeMax) && <PropertyRow label="Check Size Max" value={contact.typicalCheckSizeMax} type="currency" editMode={isEditing} onSave={(v) => save('typicalCheckSizeMax', v)} />}
          {show(contact.investmentStageFocus) && <PropertyRow label="Stage Focus" value={contact.investmentStageFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentStageFocus', v)} />}
          {show(contact.investmentSectorFocus) && <PropertyRow label="Sector Focus" value={contact.investmentSectorFocus} type="text" editMode={isEditing} onSave={(v) => save('investmentSectorFocus', v)} />}
          {show(contact.investorStage) && <PropertyRow label="Investor Stage" value={contact.investorStage} type="text" editMode={isEditing} onSave={(v) => save('investorStage', v)} />}
          {show(contact.proudPortfolioCompanies) && <PropertyRow label="Portfolio Cos" value={contact.proudPortfolioCompanies} type="text" editMode={isEditing} onSave={(v) => save('proudPortfolioCompanies', v)} />}
        </>
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
      />

      {createFieldOpen && (
        <CreateCustomFieldModal
          entityType="contact"
          onSaved={() => setCreateFieldOpen(false)}
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
