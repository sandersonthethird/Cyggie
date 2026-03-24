/**
 * ReconcileModal — streaming proposal review modal shown when concluding a partner meeting.
 *
 * State machine:
 *
 *  'generating' ──[proposals stream in]──▶ 'generating' (cards appear)
 *       │                                           │
 *  [Cancel clicked]                      [invoke resolves/rejects]
 *       │                                           │
 *  [CANCEL IPC]                               'ready' | 'error'
 *  [onClose()]                                       │
 *                                    [Apply & Conclude clicked]
 *                                                    │
 *                                       ┌────────────┴────────────┐
 *                                   no failures              failures
 *                                       │                        │
 *                               [conclude+navigate]       show errors inline
 *                                                     ┌──────────┴──────────┐
 *                                                [Continue & Conclude]   [Abort]
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type {
  ReconcileProposal,
  ApplyReconciliationInput,
  ApplyReconciliationResult,
} from '../../../shared/types/partner-meeting'
import { api } from '../../api'
import styles from './ReconcileModal.module.css'

interface PerProposalState {
  applyNote: boolean
  noteContent: string
  applyFieldUpdates: boolean
  applyTasks: boolean
  expanded: boolean
}

interface ReconcileModalProps {
  digestId: string
  meetingId: string | null
  weekOf: string
  proposals: ReconcileProposal[]
  state: 'generating' | 'ready' | 'error'
  onConclude: () => void
  onClose: () => void
}

const CATEGORY_LABELS: Record<string, string> = {
  action_item: 'Action',
  decision: 'Decision',
  follow_up: 'Follow-up',
}

export function ReconcileModal({
  digestId,
  meetingId,
  weekOf,
  proposals,
  state,
  onConclude,
  onClose,
}: ReconcileModalProps) {
  const [perCard, setPerCard] = useState<Record<string, PerProposalState>>({})
  const [applying, setApplying] = useState(false)
  const [applyErrors, setApplyErrors] = useState<ApplyReconciliationResult['failed']>([])
  const [showErrorActions, setShowErrorActions] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  // Initialize state for each proposal as it arrives; auto-expand the first
  useEffect(() => {
    for (const p of proposals) {
      setPerCard(prev => {
        if (prev[p.companyId]) return prev
        const isFirst = Object.keys(prev).length === 0
        return {
          ...prev,
          [p.companyId]: {
            applyNote: !p.error,
            noteContent: p.noteContent,
            applyFieldUpdates: !p.error,
            applyTasks: !p.error,
            expanded: isFirst,
          },
        }
      })
    }
  }, [proposals])

  // Auto-scroll last card into view when a new one arrives
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [proposals.length])

  const updateCard = useCallback((companyId: string, patch: Partial<PerProposalState>) => {
    setPerCard(prev => prev[companyId]
      ? { ...prev, [companyId]: { ...prev[companyId], ...patch } }
      : prev
    )
  }, [])

  const handleAcceptAll = useCallback(() => {
    setPerCard(prev => {
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        const p = proposals.find(x => x.companyId === id)
        if (!p?.error) {
          next[id] = { ...next[id], applyNote: true, applyFieldUpdates: true, applyTasks: true }
        }
      }
      return next
    })
  }, [proposals])

  const handleDeselectAll = useCallback(() => {
    setPerCard(prev => {
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        next[id] = { ...next[id], applyNote: false, applyFieldUpdates: false, applyTasks: false }
      }
      return next
    })
  }, [])

  const handleCancel = useCallback(async () => {
    try {
      await api.invoke(IPC_CHANNELS.PARTNER_MEETING_RECONCILE_CANCEL, digestId)
    } catch { /* ignore */ }
    onClose()
  }, [digestId, onClose])

  const handleApplyAndConclude = useCallback(async () => {
    const input: ApplyReconciliationInput = {
      digestId,
      meetingId,
      proposals: proposals.map(p => {
        const card = perCard[p.companyId]
        return {
          companyId: p.companyId,
          companyName: p.companyName,
          applyNote: card?.applyNote ?? false,
          noteContent: card?.noteContent ?? p.noteContent,
          applyFieldUpdates: card?.applyFieldUpdates ?? false,
          fieldUpdates: p.fieldUpdates,
          applyTasks: card?.applyTasks ?? false,
          tasks: p.tasks,
        }
      }),
    }

    setApplying(true)
    try {
      const result = await api.invoke<ApplyReconciliationResult>(
        IPC_CHANNELS.PARTNER_MEETING_APPLY_RECONCILIATION,
        input,
      )
      if (result.failed.length > 0) {
        setApplyErrors(result.failed)
        setShowErrorActions(true)
        setApplying(false)
        return
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Apply failed'
      setApplyErrors([{ companyId: '', companyName: 'All companies', error: msg }])
      setShowErrorActions(true)
      setApplying(false)
      return
    }
    setApplying(false)
    onConclude()
  }, [digestId, meetingId, proposals, perCard, onConclude])

  const handleConcludeWithoutSaving = useCallback(() => {
    onConclude()
  }, [onConclude])

  const handleContinueAndConclude = useCallback(() => {
    setShowErrorActions(false)
    onConclude()
  }, [onConclude])

  const weekDate = new Date(weekOf + 'T00:00:00')
  const weekLabel = weekDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <div className={styles.modalTitle}>
            Review Meeting Notes — {weekLabel}
            {state === 'generating' && <span className={styles.spinner} />}
          </div>
          {state !== 'generating' && (
            <div className={styles.bulkActions}>
              <button className={styles.bulkBtn} onClick={handleAcceptAll}>✓ Accept all</button>
              <button className={styles.bulkBtn} onClick={handleDeselectAll}>Deselect all</button>
            </div>
          )}
        </div>

        {/* Error summary */}
        {showErrorActions && applyErrors.length > 0 && (
          <div className={styles.errorBanner}>
            <div className={styles.errorBannerTitle}>
              {applyErrors.length} {applyErrors.length === 1 ? 'company' : 'companies'} failed to apply:
            </div>
            {applyErrors.map((e, i) => (
              <div key={i} className={styles.errorBannerRow}>
                {e.companyName}: {e.error}
              </div>
            ))}
            <div className={styles.errorBannerActions}>
              <button className={styles.continueBtn} onClick={handleContinueAndConclude}>
                Continue &amp; Conclude
              </button>
              <button className={styles.abortBtn} onClick={() => setShowErrorActions(false)}>
                Abort
              </button>
            </div>
          </div>
        )}

        {/* Card list */}
        <div ref={listRef} className={styles.cardList}>
          {proposals.length === 0 && state === 'generating' && (
            <div className={styles.generatingHint}>Generating proposals…</div>
          )}
          {proposals.map(p => {
            const card = perCard[p.companyId]
            if (!card) return null

            return (
              <div key={p.companyId} className={`${styles.card} ${p.error ? styles.cardError : ''}`}>
                {/* Card header */}
                <div className={styles.cardHeader}>
                  <button
                    className={styles.cardToggle}
                    onClick={() => updateCard(p.companyId, { expanded: !card.expanded })}
                  >
                    {card.expanded ? '▾' : '▶'} {p.companyName}
                  </button>
                  {p.error && <span className={styles.errorBadge}>⚠ {p.error}</span>}
                </div>

                {/* Expanded card body */}
                {card.expanded && (
                  <div className={styles.cardBody}>
                    {/* Note */}
                    {!p.error && (
                      <div className={styles.cardRow}>
                        <label className={styles.checkRow}>
                          <input
                            type="checkbox"
                            checked={card.applyNote}
                            onChange={e => updateCard(p.companyId, { applyNote: e.target.checked })}
                          />
                          <span>Add note: <em>{p.noteTitle}</em></span>
                        </label>
                        {card.applyNote && (
                          <textarea
                            className={styles.noteTextarea}
                            value={card.noteContent}
                            onChange={e => updateCard(p.companyId, { noteContent: e.target.value })}
                            rows={6}
                          />
                        )}
                      </div>
                    )}

                    {/* Field updates */}
                    {!p.error && p.fieldUpdates.length > 0 && (
                      <div className={styles.cardRow}>
                        <label className={styles.checkRow}>
                          <input
                            type="checkbox"
                            checked={card.applyFieldUpdates}
                            onChange={e => updateCard(p.companyId, { applyFieldUpdates: e.target.checked })}
                          />
                          <span>Update CRM fields:</span>
                        </label>
                        {card.applyFieldUpdates && (
                          <div className={styles.fieldChips}>
                            {p.fieldUpdates.map((fu, i) => (
                              <span key={i} className={styles.fieldChip}>
                                {fu.field}: {fu.from ?? '—'} → {fu.to}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tasks */}
                    {!p.error && p.tasks.length > 0 && (
                      <div className={styles.cardRow}>
                        <label className={styles.checkRow}>
                          <input
                            type="checkbox"
                            checked={card.applyTasks}
                            onChange={e => updateCard(p.companyId, { applyTasks: e.target.checked })}
                          />
                          <span>Create {p.tasks.length} task{p.tasks.length !== 1 ? 's' : ''}:</span>
                        </label>
                        {card.applyTasks && (
                          <ul className={styles.taskList}>
                            {p.tasks.map((t, i) => (
                              <li key={i} className={styles.taskItem}>
                                <span className={`${styles.categoryBadge} ${styles[`cat_${t.category}`]}`}>
                                  {CATEGORY_LABELS[t.category] ?? t.category}
                                </span>
                                {t.title}
                                {t.assignee && <span className={styles.assignee}> — {t.assignee}</span>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}

                    {p.error && (
                      <div className={styles.cardErrorMsg}>
                        Could not generate proposal. This company will be skipped.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Footer */}
        <div className={styles.modalFooter}>
          {state === 'generating' ? (
            <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
          ) : (
            <span />
          )}
          <div className={styles.footerRight}>
            <button
              className={styles.skipBtn}
              onClick={handleConcludeWithoutSaving}
              disabled={applying}
            >
              Conclude without saving
            </button>
            {state !== 'generating' && (
              <button
                className={styles.applyBtn}
                onClick={handleApplyAndConclude}
                disabled={applying}
              >
                {applying ? 'Applying…' : 'Apply & Conclude'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
