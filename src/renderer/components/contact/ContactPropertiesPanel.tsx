import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactDetail } from '../../../shared/types/contact'
import { ContactAvatar } from '../crm/ContactAvatar'
import { PropertyRow } from '../crm/PropertyRow'
import { SocialsEditor } from '../crm/SocialsEditor'
import { CustomFieldsPanel } from '../crm/CustomFieldsPanel'
import styles from './ContactPropertiesPanel.module.css'

interface ContactPropertiesPanelProps {
  contact: ContactDetail
  onUpdate: (updates: Record<string, unknown>) => void
}

function SectionHeader({ title }: { title: string }) {
  return <div className={styles.sectionHeader}>{title}</div>
}

export function ContactPropertiesPanel({ contact, onUpdate }: ContactPropertiesPanelProps) {
  const navigate = useNavigate()
  const [isEditing, setIsEditing] = useState(false)
  const [showAllFields, setShowAllFields] = useState(false)
  const [nameDraft, setNameDraft] = useState(contact.fullName)
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Sync name draft when entering edit mode
  useEffect(() => {
    if (isEditing) {
      setNameDraft(contact.fullName)
      setTimeout(() => nameInputRef.current?.focus(), 0)
    }
  }, [isEditing, contact.fullName])

  function save(field: string, value: unknown) {
    return window.api
      .invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { [field]: value })
      .then(() => { onUpdate({ [field]: value }) })
  }

  function copyEmail(email: string) {
    navigator.clipboard.writeText(email).catch(console.error)
  }

  function handleDone() {
    // Save name if changed
    const trimmed = nameDraft.trim()
    if (trimmed && trimmed !== contact.fullName) {
      const spaceIdx = trimmed.indexOf(' ')
      const firstName = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed
      const lastName = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1) : ''
      window.api
        .invoke(IPC_CHANNELS.CONTACT_UPDATE, contact.id, { firstName, lastName })
        .then(() => { onUpdate({ firstName, lastName, fullName: trimmed }) })
        .catch(console.error)
    }
    setIsEditing(false)
  }

  function handleNameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleDone()
    if (e.key === 'Escape') setIsEditing(false)
  }

  // Returns true if a field should be shown
  function show(value: unknown): boolean {
    if (isEditing || showAllFields) return true
    return value !== null && value !== undefined && value !== ''
  }

  const hasHiddenFields = !isEditing && !showAllFields && (
    !contact.phone || !contact.linkedinUrl || !contact.twitterHandle ||
    !contact.city || !contact.state || !contact.timezone ||
    !contact.previousCompanies || !contact.university || !contact.tags || !contact.pronouns
  )

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <ContactAvatar name={contact.fullName} size="lg" />
        <div className={styles.headerMeta}>
          {isEditing ? (
            <input
              ref={nameInputRef}
              className={styles.nameInput}
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={handleNameKeyDown}
            />
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
            <select
              className={styles.badge}
              value={contact.contactType ?? ''}
              onChange={(e) => save('contactType', e.target.value || null)}
            >
              <option value="">—</option>
              <option value="investor">investor</option>
              <option value="founder">founder</option>
              <option value="operator">operator</option>
            </select>
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

      <CustomFieldsPanel entityType="contact" entityId={contact.id} />
    </div>
  )
}
