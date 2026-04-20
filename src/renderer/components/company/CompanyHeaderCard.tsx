import React, { type ReactNode, type HTMLAttributes, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Share2, AtSign, Link, Mail, ListTodo, CalendarSync } from 'lucide-react'
import type { CompanyDetail } from '../../../shared/types/company'
import { RecordKebabMenu } from '../common/RecordKebabMenu'
import { PropertyRow } from '../crm/PropertyRow'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import styles from './CompanyPropertiesPanel.module.css'

const CHIP_LABELS: Record<string, string> = {
  entityType: 'Type',
  pipelineStage: 'Stage',
  priority: 'Priority',
  round: 'Round',
}

function HealthBadge({ lastTouchpoint }: { lastTouchpoint: string | null }) {
  const days = (() => {
    if (!lastTouchpoint) return null
    const diff = Date.now() - new Date(lastTouchpoint).getTime()
    return Math.floor(diff / 86_400_000)
  })()
  if (days == null) return <span className={`${styles.healthBadge} ${styles.healthNone}`}>No contact</span>
  if (days <= 7) return <span className={`${styles.healthBadge} ${styles.healthGreen}`}>{days}d ago</span>
  if (days <= 30) return <span className={`${styles.healthBadge} ${styles.healthYellow}`}>{days}d ago</span>
  return <span className={`${styles.healthBadge} ${styles.healthRed}`}>{days}d ago</span>
}

function googleFaviconUrl(domain: string | null): string | null {
  if (!domain) return null
  return `https://www.google.com/s2/favicons?sz=32&domain=${domain}`
}

interface CompanyHeaderCardProps {
  company: CompanyDetail
  isEditing: boolean

  // Name editing
  nameDraft: string
  nameError: string | null
  nameInputRef: RefObject<HTMLInputElement | null>
  onNameChange: (value: string) => void
  onNameKeyDown: (e: ReactKeyboardEvent) => void

  // Kebab menu callbacks
  onStartEditing: () => void
  hasEnrich: boolean
  onEnrichClick: () => void
  onMerge: () => void
  onDelete: () => void

  // Edit mode actions
  sessionNewFields: string[] | null
  applyPromptLabel: React.ReactNode
  deleting: boolean
  onDone: () => void
  onApplyAll: () => void
  onJustThis: () => void
  onResetLayout: () => void

  // Badge / chip system
  headerBadgesRef: RefObject<HTMLDivElement | null>
  effectiveOrder: string[]
  hiddenHeaderChips: string[]
  dragOverSection: string | null
  chipDragOverIndex: number | null
  syncedSectionDragProps: (key: string) => HTMLAttributes<HTMLDivElement>
  chipDragProps: (id: string) => HTMLAttributes<HTMLDivElement>
  chipDropZoneProps: (i: number) => HTMLAttributes<HTMLDivElement>
  renderChipById: (id: string) => ReactNode
  renderPinnedChip: (id: string) => ReactNode | null
  onHideChip: (id: string) => void
  onRestoreChip: (id: string) => void
  /** Just id + label needed for hidden chip placeholder labels */
  companyDefLabels: { id: string; label: string }[]

  // View mode action buttons
  primaryEmail: string | null
  onTaskClick: () => void
  onOpenSync?: () => void
  digestItem: { brief?: string | null; section?: string } | null | 'loading'

  // Description
  descriptionRef: RefObject<HTMLParagraphElement | null>
  descriptionExpanded: boolean
  descriptionClamped: boolean
  onDescriptionToggle: (expanded: boolean) => void
  showDescription: boolean
  onSaveDescription: (value: unknown) => void
  fieldSources?: Record<string, { meetingId: string; meetingTitle: string }>

  // Social / website
  onSaveWebsite: (value: unknown) => void
}

export function CompanyHeaderCard({
  company,
  isEditing,
  nameDraft,
  nameError,
  nameInputRef,
  onNameChange,
  onNameKeyDown,
  onStartEditing,
  hasEnrich,
  onEnrichClick,
  onMerge,
  onDelete,
  sessionNewFields,
  applyPromptLabel,
  deleting,
  onDone,
  onApplyAll,
  onJustThis,
  onResetLayout,
  headerBadgesRef,
  effectiveOrder,
  hiddenHeaderChips,
  dragOverSection,
  chipDragOverIndex,
  syncedSectionDragProps,
  chipDragProps,
  chipDropZoneProps,
  renderChipById,
  renderPinnedChip,
  onHideChip,
  onRestoreChip,
  companyDefLabels,
  primaryEmail,
  onTaskClick,
  onOpenSync,
  digestItem,
  descriptionRef,
  descriptionExpanded,
  descriptionClamped,
  onDescriptionToggle,
  showDescription,
  onSaveDescription,
  fieldSources,
  onSaveWebsite,
}: CompanyHeaderCardProps) {
  const faviconUrl = googleFaviconUrl(company.primaryDomain)
  const openExternal = (url: string) => { void api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, url) }

  return (
    <div className={styles.header}>
      <div className={styles.headerTopRow}>
        {faviconUrl && (
          <img
            src={faviconUrl}
            className={styles.logo}
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            alt=""
          />
        )}
        <div className={styles.headerMeta}>
          {/* 3-dot kebab menu */}
          {!isEditing && (
            <div className={styles.kebabPosition}>
              <RecordKebabMenu groups={[
                [
                  { label: 'Edit record', onClick: onStartEditing },
                  ...(hasEnrich ? [{ label: 'Enrich', onClick: onEnrichClick }] : []),
                ],
                [{ label: 'Merge', onClick: onMerge }],
                [{ label: 'Delete company', onClick: onDelete, destructive: true }],
              ]} />
            </div>
          )}

          {/* Name */}
          {isEditing ? (
            <>
              <input
                ref={nameInputRef}
                className={styles.nameInput}
                value={nameDraft}
                onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={onNameKeyDown}
              />
              {nameError && (
                <div className={styles.nameError}>
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Z" fill="currentColor"/>
                    <path d="M7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5ZM8 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" fill="currentColor"/>
                  </svg>
                  {nameError}
                </div>
              )}
            </>
          ) : (
            <>
              <div className={styles.companyName}>{company.canonicalName}</div>
              {company.websiteUrl && (
                <button className={styles.websiteLink} onClick={() => openExternal(company.websiteUrl!)}>
                  {company.primaryDomain ?? company.websiteUrl}
                </button>
              )}
            </>
          )}

          {/* Header badges */}
          <div
            className={`${styles.headerBadges} ${isEditing && dragOverSection === 'summary' ? styles.dropTarget : ''}`}
            ref={headerBadgesRef}
            {...(isEditing ? syncedSectionDragProps('summary') : {})}
          >
            {effectiveOrder.map((id, i) => {
              const isCustom = id.startsWith('custom:')
              if (isCustom && renderPinnedChip(id) === null) return null

              const isHidden = hiddenHeaderChips.includes(id)
              if (!isEditing && isHidden) return null

              const chipDisplayLabel = CHIP_LABELS[id] ?? (isCustom
                ? (companyDefLabels.find((d) => d.id === id.slice(7))?.label ?? id)
                : id)

              return (
                <div
                  key={id}
                  className={`${styles.headerChipDraggable} ${chipDragOverIndex === i ? styles.chipDropIndicator : ''} ${isEditing && isHidden ? styles.hiddenHeaderChip : ''}`}
                  {...chipDropZoneProps(i)}
                >
                  <div {...chipDragProps(id)}>
                    {isEditing && isHidden ? (
                      <span className={styles.hiddenChipPlaceholder}>
                        {chipDisplayLabel}
                        <button className={styles.restoreChipBtn} title="Restore chip" onClick={() => onRestoreChip(id)}>↺</button>
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
                          <button className={styles.hideChipBtn} title="Hide chip" onClick={() => onHideChip(id)}>×</button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
            {!isEditing && <HealthBadge lastTouchpoint={company.lastTouchpoint} />}
          </div>

          {/* Action buttons / edit controls */}
          {isEditing ? (
            <div className={styles.editActions}>
              {sessionNewFields !== null ? (
                <div className={styles.applyPrompt}>
                  <span>{applyPromptLabel}</span>
                  <button className={styles.applyAllBtn} onClick={onApplyAll}>All companies</button>
                  <button className={styles.applyOneBtn} onClick={onJustThis}>Just {company.canonicalName}</button>
                </div>
              ) : (
                <>
                  <button className={styles.resetLayoutBtn} onClick={onResetLayout} title="Reset layout to default">↺</button>
                  <button
                    className={styles.doneBtn}
                    onMouseDown={() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() }}
                    onClick={() => void onDone()}
                    disabled={deleting}
                  >Done</button>
                </>
              )}
            </div>
          ) : (
            <div className={styles.headerActionRow}>
              {primaryEmail && (
                <button
                  className={styles.headerIconBtn}
                  data-tooltip="Email"
                  onClick={() => {
                    void api.invoke(
                      IPC_CHANNELS.APP_OPEN_EXTERNAL_URL,
                      `https://mail.google.com/mail/?view=cm&tf=1&to=${encodeURIComponent(primaryEmail)}`
                    )
                  }}
                ><Mail size={14} /></button>
              )}
              <button
                className={styles.headerIconBtn}
                data-tooltip="Add task"
                onClick={onTaskClick}
              ><ListTodo size={14} /></button>
              {onOpenSync && digestItem !== 'loading' && (
                <button
                  className={`${styles.headerIconBtn} ${digestItem ? styles.headerIconBtnActive : ''}`}
                  data-tooltip={digestItem ? 'In Partner Sync' : 'Add to Partner Sync'}
                  onClick={onOpenSync}
                ><CalendarSync size={14} /></button>
              )}
            </div>
          )}
        </div>
      </div>{/* end headerTopRow */}

      {/* Description */}
      {showDescription && (
        isEditing ? (
          <PropertyRow label="Description" value={company.description} type="textarea" editMode={true} onSave={onSaveDescription} />
        ) : (
          <div className={styles.descriptionWrapper}>
            <div className={styles.propertyWithBadge}>
              <p
                ref={descriptionRef}
                className={descriptionExpanded ? styles.descriptionText : styles.descriptionTextClamped}
              >
                {company.description}
              </p>
              {fieldSources?.description && (
                <span className={styles.sourceBadge} title={`From: ${fieldSources.description.meetingTitle}`}>📋</span>
              )}
            </div>
            {descriptionClamped && !descriptionExpanded && (
              <button className={styles.descriptionToggleBtn} onClick={() => onDescriptionToggle(true)}>more</button>
            )}
            {descriptionExpanded && (
              <button className={styles.descriptionToggleBtn} onClick={() => onDescriptionToggle(false)}>less</button>
            )}
          </div>
        )
      )}

      {/* Social links */}
      {isEditing ? (
        <PropertyRow label="Website" value={company.websiteUrl} type="url" editMode={true} onSave={onSaveWebsite} />
      ) : (
        (company.websiteUrl || company.linkedinCompanyUrl || company.twitterHandle || company.crunchbaseUrl || company.angellistUrl) && (
          <div className={styles.socialRow}>
            {company.linkedinCompanyUrl && (
              <button className={styles.socialIcon} title="LinkedIn" onClick={() => openExternal(company.linkedinCompanyUrl!)}>
                <Share2 size={16} />
              </button>
            )}
            {company.twitterHandle && (
              <button className={styles.socialIcon} title={`@${company.twitterHandle}`} onClick={() => openExternal(`https://twitter.com/${company.twitterHandle}`)}>
                <AtSign size={16} />
              </button>
            )}
            {company.crunchbaseUrl && (
              <button className={styles.socialIcon} title="Crunchbase" onClick={() => openExternal(company.crunchbaseUrl!)}>
                <Link size={16} />
              </button>
            )}
          </div>
        )
      )}
    </div>
  )
}
