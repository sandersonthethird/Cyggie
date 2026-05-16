/**
 * ContactModalsCollection — the four modal/overlay blocks that live at the top
 * of ContactPropertiesPanel's headerCard. Extracted to keep the parent file
 * focused on layout orchestration.
 *
 *   ┌─ EnrichMethodModal      (chosen from kebab → "Enrich")
 *   ├─ ConfirmDialog          (delete contact)
 *   ├─ ConfirmDialog          (merge contact — second-step confirm)
 *   └─ Merge picker overlay   (first-step contact search)
 *
 * The LinkedIn confirm modal stays inline in the parent — it's contextually
 * tied to the LinkedIn URL status row inside bodyCard, not the header.
 *
 * Imports the parent's CSS module for the merge-picker styles (CSS modules
 * scope by file path, so styles are shared). Matches the established
 * ContactHeaderCard / CompanyHeaderCard pattern.
 */

import type { ContactDetail } from '../../../shared/types/contact'
import ConfirmDialog from '../common/ConfirmDialog'
import { EnrichMethodModal } from '../common/EnrichMethodModal'
import styles from './ContactPropertiesPanel.module.css'

function formatRelativeTime(isoString: string | null | undefined): string {
  if (!isoString) return ''
  const ms = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 2) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface MergeTarget {
  id: string
  name: string
}

interface ContactModalsCollectionProps {
  contact: ContactDetail

  // Enrich method modal
  enrichMethodModalOpen: boolean
  setEnrichMethodModalOpen: (v: boolean) => void
  showEnrichBanner: boolean
  onEnrichFromMeetings?: () => void
  enrichMeetingCount?: number
  exaApiKey?: string
  onLinkedInEnrich: () => void | Promise<void>
  onFindOnLinkedIn: () => void | Promise<void>

  // Delete-contact confirm
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  deleting: boolean
  onDeleteContact: () => void | Promise<void>

  // Merge-into confirm (second step)
  mergeTarget: MergeTarget | null
  setMergeTarget: (target: MergeTarget | null) => void
  merging: boolean
  onMergeInto: () => void | Promise<void>

  // Merge picker (first step)
  mergePickerOpen: boolean
  setMergePickerOpen: (v: boolean) => void
  mergeQuery: string
  setMergeQuery: (q: string) => void
  mergeResults: MergeTarget[]
}

export function ContactModalsCollection({
  contact,
  enrichMethodModalOpen,
  setEnrichMethodModalOpen,
  showEnrichBanner,
  onEnrichFromMeetings,
  enrichMeetingCount,
  exaApiKey,
  onLinkedInEnrich,
  onFindOnLinkedIn,
  confirmDelete,
  setConfirmDelete,
  deleting,
  onDeleteContact,
  mergeTarget,
  setMergeTarget,
  merging,
  onMergeInto,
  mergePickerOpen,
  setMergePickerOpen,
  mergeQuery,
  setMergeQuery,
  mergeResults,
}: ContactModalsCollectionProps) {
  return (
    <>
      <EnrichMethodModal
        open={enrichMethodModalOpen}
        onClose={() => setEnrichMethodModalOpen(false)}
        title="Enrich contact"
        subtitle="Choose a source to enrich this contact's profile."
        methods={[
          ...(showEnrichBanner && onEnrichFromMeetings ? [{
            icon: '✨',
            label: 'From meetings',
            description: `${enrichMeetingCount ?? 0} new meeting${(enrichMeetingCount ?? 0) !== 1 ? 's' : ''} available`,
            onClick: () => onEnrichFromMeetings(),
          }] : []),
          ...(contact.linkedinUrl ? [{
            icon: '🔗',
            label: contact.linkedinEnrichedAt ? 'Re-enrich from LinkedIn' : 'Enrich from LinkedIn',
            description: contact.linkedinEnrichedAt
              ? `Last enriched ${formatRelativeTime(contact.linkedinEnrichedAt)}`
              : 'Pull profile data from LinkedIn',
            onClick: () => void onLinkedInEnrich(),
          }] : exaApiKey ? [{
            icon: '🔍',
            label: 'Find on LinkedIn',
            description: 'Search for this contact on LinkedIn',
            onClick: () => void onFindOnLinkedIn(),
          }] : []),
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete contact?"
        message={`This will permanently delete ${contact.fullName}.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
        onConfirm={onDeleteContact}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={!!mergeTarget}
        title="Merge contacts?"
        message={`Merge "${contact.fullName}" into "${mergeTarget?.name ?? ''}"? All meetings, emails, and notes will be relinked and this contact will be deleted.`}
        confirmLabel={merging ? 'Merging…' : 'Merge'}
        variant="danger"
        onConfirm={onMergeInto}
        onCancel={() => setMergeTarget(null)}
      />

      {mergePickerOpen && (
        <div className={styles.mergePickerOverlay} onClick={() => setMergePickerOpen(false)}>
          <div className={styles.mergePicker} onClick={e => e.stopPropagation()}>
            <p className={styles.mergePickerTitle}>
              Merge &ldquo;{contact.fullName}&rdquo; into:
            </p>
            <input
              autoFocus
              className={styles.mergePickerInput}
              placeholder="Search contacts…"
              value={mergeQuery}
              onChange={e => setMergeQuery(e.target.value)}
              onKeyDown={e => e.key === 'Escape' && setMergePickerOpen(false)}
            />
            <div className={styles.mergePickerList}>
              {mergeResults.map(r => (
                <button
                  key={r.id}
                  className={styles.mergePickerOption}
                  onClick={() => { setMergeTarget(r); setMergePickerOpen(false) }}
                >
                  {r.name}
                </button>
              ))}
              {mergeResults.length === 0 && (
                <span className={styles.mergePickerEmpty}>
                  {mergeQuery ? 'No contacts found' : 'Start typing to search…'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
