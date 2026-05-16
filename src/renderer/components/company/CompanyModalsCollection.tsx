/**
 * CompanyModalsCollection — the 5 modal/overlay blocks that live in the
 * "Modals (fixed position, outside card flow)" section at the bottom of
 * CompanyPropertiesPanel. Extracted to keep the parent file focused on
 * layout orchestration.
 *
 *   ┌─ Merge picker overlay   (first-step company search)
 *   ├─ DecisionLogModal       (new decision — create)
 *   ├─ DecisionLogModal       (edit existing decision)
 *   ├─ EnrichMethodModal      (kebab → "Enrich") — gated on onEnrich prop
 *   ├─ ConfirmDialog          (delete company)
 *   └─ MergeReviewModal       (second-step merge with field review)
 *
 * Imports the parent's CSS module for merge-picker styles. Matches the
 * established Contact / Company decomposition pattern (CSS modules scope
 * by file path).
 */

import { useNavigate } from 'react-router-dom'
import type { CompanyDetail, CompanyDecisionLog } from '../../../shared/types/company'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import ConfirmDialog from '../common/ConfirmDialog'
import { EnrichMethodModal } from '../common/EnrichMethodModal'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import { MergeReviewModal } from './MergeReviewModal'
import styles from './CompanyPropertiesPanel.module.css'

interface MergeTarget {
  id: string
  name: string
}

type EnrichSource = 'pdf' | 'url' | 'meetings' | 'notes' | 'emails'

interface CompanyModalsCollectionProps {
  company: CompanyDetail

  // Merge picker (first step)
  mergePickerOpen: boolean
  setMergePickerOpen: (v: boolean) => void
  mergeQuery: string
  setMergeQuery: (q: string) => void
  mergeResults: MergeTarget[]
  mergeTarget: MergeTarget | null
  setMergeTarget: (t: MergeTarget | null) => void

  // Decision log
  showDecisionModal: boolean
  setShowDecisionModal: (v: boolean) => void
  decisionTriggerType: string | undefined
  editDecisionId: string | null
  setEditDecisionId: (id: string | null) => void
  setLatestDecision: (d: CompanyDecisionLog | null) => void

  // Enrich method
  enrichMethodModalOpen: boolean
  setEnrichMethodModalOpen: (v: boolean) => void
  onEnrich?: (source: EnrichSource) => void
  showEnrichBanner: boolean
  enrichMeetingCount: number

  // Confirm delete
  confirmDelete: boolean
  setConfirmDelete: (v: boolean) => void
  deleting: boolean
  deleteErrorMessage: string | null
  clearDeleteError: () => void
  onDeleteCompany: () => void | Promise<void>
}

export function CompanyModalsCollection({
  company,
  mergePickerOpen,
  setMergePickerOpen,
  mergeQuery,
  setMergeQuery,
  mergeResults,
  mergeTarget,
  setMergeTarget,
  showDecisionModal,
  setShowDecisionModal,
  decisionTriggerType,
  editDecisionId,
  setEditDecisionId,
  setLatestDecision,
  enrichMethodModalOpen,
  setEnrichMethodModalOpen,
  onEnrich,
  showEnrichBanner,
  enrichMeetingCount,
  confirmDelete,
  setConfirmDelete,
  deleting,
  deleteErrorMessage,
  clearDeleteError,
  onDeleteCompany,
}: CompanyModalsCollectionProps) {
  const navigate = useNavigate()

  return (
    <>
      {mergePickerOpen && (
        <div className={styles.mergePickerOverlay} onClick={() => setMergePickerOpen(false)}>
          <div className={styles.mergePicker} onClick={e => e.stopPropagation()}>
            <p className={styles.mergePickerTitle}>Merge &ldquo;{company.canonicalName}&rdquo; into:</p>
            <input
              autoFocus
              className={styles.mergePickerInput}
              placeholder="Search companies…"
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
                  {mergeQuery ? 'No companies found' : 'Start typing to search…'}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {showDecisionModal && (
        <DecisionLogModal
          companyId={company.id}
          initialDecisionType={decisionTriggerType}
          onClose={() => setShowDecisionModal(false)}
          onSaved={() => {
            void window.api.invoke<CompanyDecisionLog | null>(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, company.id).then(d => setLatestDecision(d ?? null))
            setShowDecisionModal(false)
          }}
        />
      )}

      {editDecisionId && (
        <DecisionLogModal
          companyId={company.id}
          logId={editDecisionId}
          onClose={() => setEditDecisionId(null)}
          onSaved={() => {
            void window.api.invoke<CompanyDecisionLog | null>(IPC_CHANNELS.COMPANY_DECISION_LOG_GET_LATEST, company.id).then(d => setLatestDecision(d ?? null))
            setEditDecisionId(null)
          }}
          onDeleted={() => { setLatestDecision(null); setEditDecisionId(null) }}
        />
      )}

      {onEnrich && (
        <EnrichMethodModal
          open={enrichMethodModalOpen}
          onClose={() => setEnrichMethodModalOpen(false)}
          title="Enrich company"
          subtitle="Choose a source to enrich this company's profile."
          methods={[
            { icon: '📄', label: 'From a file (PDF)', description: 'Upload a pitch deck or document', onClick: () => onEnrich('pdf') },
            { icon: '🔗', label: 'From a URL', description: 'Extract from a webpage', onClick: () => onEnrich('url') },
            { icon: '✨', label: 'From meetings', description: showEnrichBanner ? `${enrichMeetingCount} new meeting${enrichMeetingCount !== 1 ? 's' : ''} available` : 'No new meetings', onClick: () => onEnrich('meetings'), disabled: !showEnrichBanner },
            { icon: '📝', label: 'From notes', description: 'Extract from company notes', onClick: () => onEnrich('notes') },
            { icon: '✉️', label: 'From emails', description: 'Extract from email threads', onClick: () => onEnrich('emails') },
          ]}
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete company?"
        message={`Delete "${company.canonicalName}" and all associated data? This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        variant="danger"
        errorMessage={deleteErrorMessage}
        onConfirm={onDeleteCompany}
        onCancel={() => { setConfirmDelete(false); clearDeleteError() }}
      />

      {mergeTarget && (
        <MergeReviewModal
          open={!!mergeTarget}
          targetId={mergeTarget.id}
          sourceId={company.id}
          onCancel={() => setMergeTarget(null)}
          onSuccess={(keptId) => {
            setMergeTarget(null)
            navigate(`/company/${keptId}`)
          }}
        />
      )}
    </>
  )
}
