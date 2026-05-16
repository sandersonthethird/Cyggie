/**
 * ContactHeaderCard — the avatar + name + company + meta + edit-actions block
 * at the top of ContactPropertiesPanel. Extracted to mirror the established
 * CompanyHeaderCard pattern.
 *
 *   ┌─── header row ─────────────────────────────────────────────────────┐
 *   │  [Avatar]   First Last           [⋯ kebab]                          │
 *   │             Company link                                            │
 *   │             Title  [📋 source-badge]                                │
 *   │             LinkedIn headline                                       │
 *   │             [Type chip]  [Last-touch badge]                         │
 *   │             [Edit/Save/Cancel/Reset/Apply prompts when editing]     │
 *   │             ✉ email           📞 phone                              │
 *   │             🔗 linkedin       📍 city, state                        │
 *   │             [✉ Mail icon-row]                                       │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Modals (Enrich, Confirm Delete, Confirm Merge, Merge Picker) live in the
 * parent for now — they'll be extracted into ContactModalsCollection later.
 *
 * Imports the parent's CSS module: CSS modules are scoped by file path, so
 * both files referencing ContactPropertiesPanel.module.css share styles.
 * Matches CompanyHeaderCard's pattern (imports CompanyPropertiesPanel.module.css).
 */

import React, { type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { Mail } from 'lucide-react'
import type { ContactDetail } from '../../../shared/types/contact'
import type { CompanySummary } from '../../../shared/types/company'
import type { CustomFieldWithValue } from '../../../shared/types/custom-fields'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import { daysSince } from '../../utils/format'
import { ContactAvatar } from '../crm/ContactAvatar'
import { RecordKebabMenu } from '../common/RecordKebabMenu'
import { CONTACT_COLUMN_DEFS } from './contactColumns'
import styles from './ContactPropertiesPanel.module.css'

function LastTouchBadge({ lastTouchpoint }: { lastTouchpoint: string | null | undefined }) {
  const days = daysSince(lastTouchpoint ?? null)
  if (days == null) return <span className={`${styles.touchBadge} ${styles.touchNone}`}>No contact</span>
  if (days <= 7) return <span className={`${styles.touchBadge} ${styles.touchGreen}`}>{days}d ago</span>
  if (days <= 30) return <span className={`${styles.touchBadge} ${styles.touchYellow}`}>{days}d ago</span>
  return <span className={`${styles.touchBadge} ${styles.touchRed}`}>{days}d ago</span>
}

interface ContactHeaderCardProps {
  contact: ContactDetail
  isEditing: boolean
  lastTouchpoint?: string | null
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>
  customFields: CustomFieldWithValue[]

  // Drafts
  firstNameDraft: string
  setFirstNameDraft: (v: string) => void
  lastNameDraft: string
  setLastNameDraft: (v: string) => void
  emailDraft: string
  setEmailDraft: (v: string) => void
  linkedinDraft: string
  setLinkedinDraft: (v: string) => void
  phoneDraft: string
  setPhoneDraft: (v: string) => void
  cityDraft: string
  setCityDraft: (v: string) => void
  stateDraft: string
  setStateDraft: (v: string) => void
  companyDraft: string
  setCompanyDraft: (v: string) => void

  // Company autocomplete
  companyAutocomplete: CompanySummary[] | null
  setCompanyAutocomplete: (v: CompanySummary[] | null) => void
  companyActiveIdx: number
  setCompanyActiveIdx: (n: number) => void
  handleCompanyInput: (v: string) => void
  companyAutocompleteKeyDown: (e: ReactKeyboardEvent) => void
  companyAutocompleteRef: RefObject<HTMLDivElement | null>
  saveCompany: (name: string) => Promise<void> | void

  // Refs
  firstNameInputRef: RefObject<HTMLInputElement | null>

  // Action handlers
  handleNameKeyDown: (e: ReactKeyboardEvent) => void
  onStartEditing: () => void
  onEnrichClick: () => void
  onMergeStart: () => void
  onDeleteClick: () => void
  handleDone: () => void | Promise<void>
  handleCancel: () => void
  handleApplyToAll: () => void
  handleJustThisContact: () => void
  handleResetLayout: () => void

  // Edit-mode state
  sessionNewFields: string[] | null
  metaSaveError: string | null

  // Copy-to-clipboard
  copyMeta: (value: string, key: string) => void
  copiedMeta: string | null

  // Chip rendering (delegated — parent owns the chip-render machinery)
  contactTypeChip: React.ReactNode
}

export function ContactHeaderCard({
  contact,
  isEditing,
  lastTouchpoint,
  fieldSources,
  customFields,

  firstNameDraft, setFirstNameDraft,
  lastNameDraft, setLastNameDraft,
  emailDraft, setEmailDraft,
  linkedinDraft, setLinkedinDraft,
  phoneDraft, setPhoneDraft,
  cityDraft, setCityDraft,
  stateDraft, setStateDraft,
  companyDraft, setCompanyDraft,

  companyAutocomplete, setCompanyAutocomplete,
  companyActiveIdx, setCompanyActiveIdx,
  handleCompanyInput, companyAutocompleteKeyDown, companyAutocompleteRef,
  saveCompany,

  firstNameInputRef,
  handleNameKeyDown,
  onStartEditing, onEnrichClick, onMergeStart, onDeleteClick,
  handleDone, handleCancel,
  handleApplyToAll, handleJustThisContact, handleResetLayout,

  sessionNewFields,
  metaSaveError,

  copyMeta, copiedMeta,
  contactTypeChip,
}: ContactHeaderCardProps) {
  const navigate = useNavigate()

  return (
    <div className={styles.header}>
      <ContactAvatar name={contact.fullName} size="lg" />
      <div className={styles.headerMeta}>
        {/* 3-dot kebab menu — upper right of headerMeta (hidden during edit mode) */}
        {!isEditing && (
          <div className={styles.kebabPosition}>
            <RecordKebabMenu groups={[
              [
                { label: 'Edit record', onClick: onStartEditing },
                { label: 'Enrich', onClick: onEnrichClick },
              ],
              [
                { label: 'Merge into', onClick: onMergeStart },
              ],
              [
                { label: 'Delete contact', onClick: onDeleteClick, destructive: true },
              ],
            ]} />
          </div>
        )}
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
        {isEditing ? (
          <div className={styles.companyEditWrapper}>
            <input
              className={styles.priorCompanyInput}
              value={companyDraft}
              placeholder="Company"
              onChange={(e) => handleCompanyInput(e.target.value)}
              onKeyDown={companyAutocompleteKeyDown}
              onBlur={() => {
                setTimeout(() => setCompanyAutocomplete(null), 150)
                void saveCompany(companyDraft)
              }}
            />
            {companyAutocomplete && companyAutocomplete.length > 0 && (
              <div
                className={styles.priorCompanyAutocomplete}
                ref={companyAutocompleteRef as React.RefObject<HTMLDivElement>}
              >
                {companyAutocomplete.map((c, i) => (
                  <div
                    key={c.id}
                    className={`${styles.priorCompanyAutocompleteItem} ${i === companyActiveIdx ? styles.priorCompanyAutocompleteItemActive : ''}`}
                    onMouseEnter={() => setCompanyActiveIdx(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      setCompanyDraft(c.canonicalName)
                      setCompanyAutocomplete(null)
                      void saveCompany(c.canonicalName)
                    }}
                  >{c.canonicalName}</div>
                ))}
              </div>
            )}
          </div>
        ) : contact.primaryCompany ? (
          <div className={styles.companyRow}>
            <button
              className={styles.companyLink}
              onClick={() => navigate(`/company/${contact.primaryCompany!.id}`, { state: { backLabel: contact.fullName } })}
            >
              {contact.primaryCompany.canonicalName}
            </button>
          </div>
        ) : null}
        {contact.title && (
          <div className={styles.titleRow}>
            <span>{contact.title}</span>
            {fieldSources?.title && (
              <span className={styles.sourceBadge} title={`From: ${fieldSources.title.meetingTitle}`}>📋</span>
            )}
          </div>
        )}
        {contact.linkedinHeadline && !isEditing && (
          <div className={styles.linkedinHeadline}>{contact.linkedinHeadline}</div>
        )}
        {/* Contact type + last touch — always visible in header */}
        <div className={styles.headerChipRow}>
          {contactTypeChip}
          {!isEditing && <LastTouchBadge lastTouchpoint={lastTouchpoint ?? contact.lastTouchpoint} />}
        </div>
        {/* Edit-mode actions */}
        {isEditing && (
          <div className={styles.editActions}>
            {sessionNewFields !== null ? (
              <div className={styles.applyPrompt}>
                {(() => {
                  function fieldLabel(key: string): string {
                    if (key.startsWith('custom:')) {
                      const id = key.slice(7)
                      return customFields.find(f => f.id === id)?.label ?? key
                    }
                    return CONTACT_COLUMN_DEFS.find(d => d.key === key)?.label ?? key
                  }
                  const promptPrefix = sessionNewFields.length > 0
                    ? `Show ${sessionNewFields.map(fieldLabel).join(', ')} on`
                    : 'Apply layout changes to'
                  return <span>{promptPrefix} <strong>all contacts</strong>?</span>
                })()}
                <button className={styles.applyAllBtn} onClick={handleApplyToAll}>All contacts</button>
                <button className={styles.applyOneBtn} onClick={handleJustThisContact}>Just {contact.fullName}</button>
              </div>
            ) : (
              <>
                <div className={styles.editBtnRow}>
                  <button className={styles.saveBtn} onClick={() => void handleDone()}>Save</button>
                  <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
                  <button className={styles.resetLayoutBtn} onClick={handleResetLayout} title="Reset layout to default">Reset Layout</button>
                </div>
                {metaSaveError && (
                  <div style={{ color: '#c0392b', fontSize: '12px', marginTop: '4px', padding: '0 8px' }}>
                    {metaSaveError}
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {/* Contact meta — edit inputs or read-only display */}
        {isEditing ? (
          <div className={styles.metaEditBlock}>
            <div className={styles.metaRow}>
              <span className={styles.metaIcon}>✉</span>
              <input
                className={styles.metaInput}
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                placeholder="Email address"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </div>
            <div className={styles.metaRow}>
              <svg className={styles.metaIconSvg} width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
              </svg>
              <input
                className={styles.metaInput}
                value={linkedinDraft}
                onChange={(e) => setLinkedinDraft(e.target.value)}
                placeholder="LinkedIn URL"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaIcon}>📞</span>
              <input
                className={styles.metaInput}
                value={phoneDraft}
                onChange={(e) => setPhoneDraft(e.target.value)}
                placeholder="Phone"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaIcon}>📍</span>
              <input
                className={`${styles.metaInput} ${styles.metaInputHalf}`}
                value={cityDraft}
                onChange={(e) => setCityDraft(e.target.value)}
                placeholder="City"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
              <input
                className={`${styles.metaInput} ${styles.metaInputHalf}`}
                value={stateDraft}
                onChange={(e) => setStateDraft(e.target.value)}
                placeholder="State"
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              />
            </div>
          </div>
        ) : (
          <>
            {(contact.emails[0] || contact.email) && (
              <div
                className={`${styles.metaRow} ${styles.metaRowCopyable}`}
                onClick={() => copyMeta((contact.emails[0] || contact.email)!, 'email')}
                title="Click to copy"
              >
                <span className={styles.metaIcon}>✉</span>
                <span className={styles.metaValue}>{contact.emails[0] || contact.email}</span>
                {copiedMeta === 'email' && <span className={styles.copiedToast}>Copied!</span>}
              </div>
            )}
            {contact.linkedinUrl && (
              <div className={styles.metaRow}>
                <svg className={styles.metaIconSvg} width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                </svg>
                <span
                  className={styles.metaLink}
                  onClick={() => void api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, contact.linkedinUrl!)}
                  title={contact.linkedinUrl}
                >
                  {contact.linkedinUrl.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '')}
                </span>
              </div>
            )}
            {contact.phone && (
              <div
                className={`${styles.metaRow} ${styles.metaRowCopyable}`}
                onClick={() => copyMeta(contact.phone!, 'phone')}
                title="Click to copy"
              >
                <span className={styles.metaIcon}>📞</span>
                <span className={styles.metaValue}>{contact.phone}</span>
                {copiedMeta === 'phone' && <span className={styles.copiedToast}>Copied!</span>}
              </div>
            )}
            {(contact.city || contact.state) && (
              <div className={styles.metaRow}>
                <span className={styles.metaIcon}>📍</span>
                <span className={styles.metaValue}>{[contact.city, contact.state].filter(Boolean).join(', ')}</span>
              </div>
            )}
            <div className={styles.headerActionRow}>
              {(contact.emails[0] || contact.email) && (
                <button
                  className={styles.headerIconBtn}
                  data-tooltip="Email"
                  onClick={() => void api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, `mailto:${contact.emails[0] || contact.email}`)}
                ><Mail size={14} /></button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
