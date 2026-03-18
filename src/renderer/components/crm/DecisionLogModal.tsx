import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type {
  CompanyDecisionLog,
  DecisionNextStep,
  DecisionLinkedArtifact,
  InvestmentMemoWithLatest
} from '../../../shared/types/company'
import type { ContactDecisionLog } from '../../../shared/types/contact'
import ConfirmDialog from '../common/ConfirmDialog'
import styles from './DecisionLogModal.module.css'
import { api } from '../../api'

const COMPANY_DECISION_TYPE_OPTIONS = [
  'Investment Approved',
  'Pass',
  'Increase Allocation',
  'Follow-on',
  'Write-Off',
  'Other'
]

const CONTACT_DECISION_TYPE_OPTIONS = [
  'Pass',
  'Advance',
  'Offer',
  'Other'
]

// Minimal shared type for onSaved callback — avoids cross-type coupling
export type SavedDecisionRef = {
  id: string
  decisionType: string
  decisionDate: string
  decisionOwner: string | null
}

type DecisionLogModalProps =
  | {
      companyId: string
      contactId?: never
      logId?: string
      initialDecisionType?: string
      onClose: () => void
      onSaved: (log: SavedDecisionRef) => void
      onDeleted?: (logId: string) => void
    }
  | {
      contactId: string
      companyId?: never
      logId?: string
      initialDecisionType?: string
      onClose: () => void
      onSaved: (log: SavedDecisionRef) => void
      onDeleted?: (logId: string) => void
    }

type ModalState =
  | { status: 'create' }
  | { status: 'loading' }
  | { status: 'editing'; log: CompanyDecisionLog }
  | { status: 'error' }

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatAddendumMarkdown(log: CompanyDecisionLog): string {
  const lines: string[] = [
    '',
    '---',
    '',
    '## Decision Addendum',
    '',
    `**Type:** ${log.decisionType}`,
    `**Date:** ${log.decisionDate}`,
  ]
  if (log.decisionOwner) lines.push(`**Owner:** ${log.decisionOwner}`)
  if (log.amountApproved) lines.push(`**Amount:** ${log.amountApproved}`)
  if (log.targetOwnership) {
    const ownershipLine = `**Ownership:** ${log.targetOwnership}${log.moreIfPossible ? ' (more if possible)' : ''}`
    lines.push(ownershipLine)
  }
  if (log.structure) lines.push(`**Structure:** ${log.structure}`)
  if (log.rationale.length > 0) {
    lines.push('', '**Rationale:**')
    log.rationale.forEach((r) => { if (r.trim()) lines.push(`- ${r}`) })
  }
  if (log.dependencies.length > 0) {
    lines.push('', '**Dependencies:**')
    log.dependencies.forEach((d) => { if (d.trim()) lines.push(`- ${d}`) })
  }
  if (log.nextSteps.length > 0) {
    lines.push('', '**Next Steps:**')
    log.nextSteps.forEach((s) => {
      if (!s.what.trim()) return
      const who = s.byWhom ? ` — ${s.byWhom}` : ''
      const due = s.dueDate ? ` (${s.dueDate})` : ''
      lines.push(`- [ ] ${s.what}${who}${due}`)
    })
  }
  lines.push('')
  return lines.join('\n')
}

export function DecisionLogModal({
  companyId,
  contactId,
  logId,
  initialDecisionType,
  onClose,
  onSaved,
  onDeleted
}: DecisionLogModalProps) {
  const isContactMode = !!contactId
  const DECISION_TYPE_OPTIONS = isContactMode ? CONTACT_DECISION_TYPE_OPTIONS : COMPANY_DECISION_TYPE_OPTIONS

  const [state, setState] = useState<ModalState>(
    logId ? { status: 'loading' } : { status: 'create' }
  )

  // Draft fields
  const [decisionType, setDecisionType] = useState(initialDecisionType ?? (isContactMode ? 'Pass' : 'Investment Approved'))
  const [decisionDate, setDecisionDate] = useState(today())
  const [decisionOwner, setDecisionOwner] = useState('')
  const [amountApproved, setAmountApproved] = useState('')
  const [targetOwnership, setTargetOwnership] = useState('')
  const [moreIfPossible, setMoreIfPossible] = useState(false)
  const [structure, setStructure] = useState('')
  const [rationale, setRationale] = useState<string[]>([''])
  const [dependencies, setDependencies] = useState<string[]>([])
  const [nextSteps, setNextSteps] = useState<DecisionNextStep[]>([])
  const [linkedArtifacts, setLinkedArtifacts] = useState<DecisionLinkedArtifact[]>([])

  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [addToMemoState, setAddToMemoState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')

  // Load existing log in edit mode
  useEffect(() => {
    if (!logId) {
      // Pre-populate owner from user profile
      api.invoke<{ displayName?: string | null }>(IPC_CHANNELS.USER_GET_CURRENT)
        .then((profile) => {
          if (profile?.displayName) setDecisionOwner(profile.displayName)
        })
        .catch(() => {})
      return
    }
    setState({ status: 'loading' })
    const getChannel = isContactMode
      ? IPC_CHANNELS.CONTACT_DECISION_LOG_GET
      : IPC_CHANNELS.COMPANY_DECISION_LOG_GET
    api.invoke<CompanyDecisionLog | ContactDecisionLog | null>(getChannel, logId)
      .then((log) => {
        if (!log) {
          setState({ status: 'error' })
          return
        }
        setDecisionType(log.decisionType)
        setDecisionDate(log.decisionDate)
        setDecisionOwner(log.decisionOwner ?? '')
        if (!isContactMode) {
          const cLog = log as CompanyDecisionLog
          setAmountApproved(cLog.amountApproved ?? '')
          setTargetOwnership(cLog.targetOwnership ?? '')
          setMoreIfPossible(cLog.moreIfPossible)
          setStructure(cLog.structure ?? '')
          setDependencies(cLog.dependencies)
          setLinkedArtifacts(cLog.linkedArtifacts)
        }
        setRationale(log.rationale.length > 0 ? log.rationale : [''])
        setNextSteps(log.nextSteps)
        setState({ status: 'editing', log: log as CompanyDecisionLog })
      })
      .catch(() => setState({ status: 'error' }))
  }, [logId, isContactMode])

  const handleClose = useCallback(() => {
    onClose()
  }, [onClose])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [handleClose])

  async function handleSave() {
    if (isSaving) return
    if (!decisionType.trim() || !decisionDate.trim()) {
      setSaveError(true)
      return
    }
    setIsSaving(true)
    setSaveError(false)
    try {
      let saved: SavedDecisionRef
      if (isContactMode) {
        const contactPayload = {
          decisionType: decisionType.trim(),
          decisionDate: decisionDate.trim(),
          decisionOwner: decisionOwner.trim() || null,
          rationale: rationale.filter((r) => r.trim()),
          nextSteps: nextSteps.filter((s) => s.what.trim())
        }
        if (logId && state.status === 'editing') {
          saved = await api.invoke<SavedDecisionRef>(
            IPC_CHANNELS.CONTACT_DECISION_LOG_UPDATE,
            logId,
            contactPayload
          )
        } else {
          saved = await api.invoke<SavedDecisionRef>(
            IPC_CHANNELS.CONTACT_DECISION_LOG_CREATE,
            { contactId, ...contactPayload }
          )
        }
      } else {
        const companyPayload = {
          decisionType: decisionType.trim(),
          decisionDate: decisionDate.trim(),
          decisionOwner: decisionOwner.trim() || null,
          amountApproved: amountApproved.trim() || null,
          targetOwnership: targetOwnership.trim() || null,
          moreIfPossible,
          structure: structure.trim() || null,
          rationale: rationale.filter((r) => r.trim()),
          dependencies: dependencies.filter((d) => d.trim()),
          nextSteps: nextSteps.filter((s) => s.what.trim()),
          linkedArtifacts: linkedArtifacts.filter((a) => a.label.trim())
        }
        if (logId && state.status === 'editing') {
          saved = await api.invoke<SavedDecisionRef>(
            IPC_CHANNELS.COMPANY_DECISION_LOG_UPDATE,
            logId,
            companyPayload
          )
        } else {
          saved = await api.invoke<SavedDecisionRef>(
            IPC_CHANNELS.COMPANY_DECISION_LOG_CREATE,
            { companyId, ...companyPayload }
          )
        }
      }
      onSaved(saved)
      onClose()
    } catch {
      setSaveError(true)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    setConfirmDelete(false)
    if (!logId) return
    try {
      const deleteChannel = isContactMode
        ? IPC_CHANNELS.CONTACT_DECISION_LOG_DELETE
        : IPC_CHANNELS.COMPANY_DECISION_LOG_DELETE
      await api.invoke(deleteChannel, logId)
      onDeleted?.(logId)
      onClose()
    } catch {
      setSaveError(true)
    }
  }

  async function handleAddToMemo() {
    const log = state.status === 'editing' ? state.log : null
    if (!log) return
    setAddToMemoState('saving')
    try {
      const memo = await api.invoke<InvestmentMemoWithLatest>(
        IPC_CHANNELS.INVESTMENT_MEMO_GET_OR_CREATE,
        companyId
      )
      const currentContent = memo.latestVersion?.contentMarkdown ?? ''
      const addendum = formatAddendumMarkdown(log)
      await api.invoke(
        IPC_CHANNELS.INVESTMENT_MEMO_SAVE_VERSION,
        memo.id,
        currentContent + addendum,
        `Decision Addendum — ${log.decisionType}`
      )
      setAddToMemoState('done')
      setTimeout(() => setAddToMemoState('idle'), 2000)
    } catch {
      setAddToMemoState('error')
      setTimeout(() => setAddToMemoState('idle'), 2500)
    }
  }

  // Rationale helpers
  function setRationaleItem(i: number, val: string) {
    setRationale((prev) => prev.map((r, idx) => (idx === i ? val : r)))
  }
  function addRationale() {
    if (rationale.length < 3) setRationale((prev) => [...prev, ''])
  }
  function removeRationale(i: number) {
    setRationale((prev) => prev.filter((_, idx) => idx !== i))
  }

  // Dependencies helpers
  function setDep(i: number, val: string) {
    setDependencies((prev) => prev.map((d, idx) => (idx === i ? val : d)))
  }
  function addDep() { setDependencies((prev) => [...prev, '']) }
  function removeDep(i: number) { setDependencies((prev) => prev.filter((_, idx) => idx !== i)) }

  // Next Steps helpers
  function setStep(i: number, field: keyof DecisionNextStep, val: string | null) {
    setNextSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, [field]: val } : s)))
  }
  function addStep() { setNextSteps((prev) => [...prev, { what: '', byWhom: null, dueDate: null }]) }
  function removeStep(i: number) { setNextSteps((prev) => prev.filter((_, idx) => idx !== i)) }

  const isEditing = state.status === 'editing'

  return createPortal(
    <>
      <div className={styles.overlay} onClick={handleClose}>
        <div
          className={styles.modal}
          role="dialog"
          aria-modal="true"
          aria-label="Decision Log"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className={styles.header}>
            <h2 className={styles.title}>
              {logId ? 'Edit Decision' : 'Log Decision'}
            </h2>
            <button className={styles.closeBtn} onClick={handleClose} title="Close">✕</button>
          </div>

          {/* Loading / Error states */}
          {state.status === 'loading' && (
            <div className={styles.stateMsg}>Loading…</div>
          )}
          {state.status === 'error' && (
            <div className={styles.stateMsg}>Failed to load decision.</div>
          )}

          {/* Form body */}
          {(state.status === 'create' || state.status === 'editing') && (
            <div className={styles.body}>
              {/* Row 1: Type + Date */}
              <div className={styles.row2}>
                <div className={styles.field}>
                  <label className={styles.label}>Decision Type</label>
                  <select
                    className={styles.select}
                    value={DECISION_TYPE_OPTIONS.includes(decisionType) ? decisionType : 'Other'}
                    onChange={(e) => setDecisionType(e.target.value)}
                  >
                    {DECISION_TYPE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Decision Date</label>
                  <input
                    type="date"
                    className={styles.input}
                    value={decisionDate}
                    onChange={(e) => setDecisionDate(e.target.value)}
                  />
                </div>
              </div>

              {/* Row 2: Owner + Amount (amount hidden in contact mode) */}
              <div className={isContactMode ? styles.row1 : styles.row2}>
                <div className={styles.field}>
                  <label className={styles.label}>Decision Owner</label>
                  <input
                    type="text"
                    className={styles.input}
                    value={decisionOwner}
                    onChange={(e) => setDecisionOwner(e.target.value)}
                    placeholder="e.g. J. Smith"
                  />
                </div>
                {!isContactMode && (
                  <div className={styles.field}>
                    <label className={styles.label}>Amount Approved</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={amountApproved}
                      onChange={(e) => setAmountApproved(e.target.value)}
                      placeholder="e.g. $2M or $1M–$3M"
                    />
                  </div>
                )}
              </div>

              {/* Row 3: Ownership + More if possible + Structure (hidden in contact mode) */}
              {!isContactMode && (
                <div className={styles.row3}>
                  <div className={styles.field}>
                    <label className={styles.label}>Target Ownership</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={targetOwnership}
                      onChange={(e) => setTargetOwnership(e.target.value)}
                      placeholder="e.g. 10%"
                    />
                  </div>
                  <div className={`${styles.field} ${styles.checkboxField}`}>
                    <label className={styles.label}>&nbsp;</label>
                    <label className={styles.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={moreIfPossible}
                        onChange={(e) => setMoreIfPossible(e.target.checked)}
                      />
                      More if possible
                    </label>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label}>Structure</label>
                    <input
                      type="text"
                      className={styles.input}
                      value={structure}
                      onChange={(e) => setStructure(e.target.value)}
                      placeholder="e.g. Direct equity, SAFE"
                    />
                  </div>
                </div>
              )}

              {/* Rationale */}
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionLabel}>Rationale</span>
                  <span className={styles.sectionHint}>up to 3 bullets</span>
                  {rationale.length < 3 && (
                    <button className={styles.addBtn} onClick={addRationale}>+ Add</button>
                  )}
                </div>
                {rationale.map((r, i) => (
                  <div key={i} className={styles.listRow}>
                    <input
                      type="text"
                      className={styles.input}
                      value={r}
                      onChange={(e) => setRationaleItem(i, e.target.value)}
                      placeholder={`Bullet ${i + 1}`}
                    />
                    {rationale.length > 1 && (
                      <button className={styles.removeBtn} onClick={() => removeRationale(i)}>✕</button>
                    )}
                  </div>
                ))}
              </div>

              {/* Dependencies (hidden in contact mode) */}
              {!isContactMode && (
                <div className={styles.section}>
                  <div className={styles.sectionHeader}>
                    <span className={styles.sectionLabel}>Dependencies / Conditions</span>
                    <button className={styles.addBtn} onClick={addDep}>+ Add</button>
                  </div>
                  {dependencies.length === 0 && (
                    <div className={styles.emptyHint}>None — click + Add to add a condition</div>
                  )}
                  {dependencies.map((d, i) => (
                    <div key={i} className={styles.listRow}>
                      <input
                        type="text"
                        className={styles.input}
                        value={d}
                        onChange={(e) => setDep(i, e.target.value)}
                        placeholder="e.g. Final legal review"
                      />
                      <button className={styles.removeBtn} onClick={() => removeDep(i)}>✕</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Next Steps */}
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionLabel}>Next Steps</span>
                  <button className={styles.addBtn} onClick={addStep}>+ Add</button>
                </div>
                {nextSteps.length === 0 && (
                  <div className={styles.emptyHint}>None — click + Add to add a step</div>
                )}
                {nextSteps.map((s, i) => (
                  <div key={i} className={styles.stepRow}>
                    <input
                      type="text"
                      className={`${styles.input} ${styles.stepWhat}`}
                      value={s.what}
                      onChange={(e) => setStep(i, 'what', e.target.value)}
                      placeholder="What"
                    />
                    <input
                      type="text"
                      className={`${styles.input} ${styles.stepWho}`}
                      value={s.byWhom ?? ''}
                      onChange={(e) => setStep(i, 'byWhom', e.target.value || null)}
                      placeholder="By whom"
                    />
                    <input
                      type="date"
                      className={`${styles.input} ${styles.stepDate}`}
                      value={s.dueDate ?? ''}
                      onChange={(e) => setStep(i, 'dueDate', e.target.value || null)}
                    />
                    <button className={styles.removeBtn} onClick={() => removeStep(i)}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Footer */}
          {(state.status === 'create' || state.status === 'editing') && (
            <div className={styles.footer}>
              <div className={styles.footerLeft}>
                {isEditing && !isContactMode && (
                  <button
                    className={`${styles.memoBtn} ${addToMemoState === 'done' ? styles.memoDone : addToMemoState === 'error' ? styles.memoError : ''}`}
                    onClick={handleAddToMemo}
                    disabled={addToMemoState === 'saving'}
                  >
                    {addToMemoState === 'saving' ? 'Adding…'
                      : addToMemoState === 'done' ? '✓ Added to memo'
                      : addToMemoState === 'error' ? 'Failed — try again'
                      : 'Add to Memo →'}
                  </button>
                )}
              </div>
              <div className={styles.footerRight}>
                {isEditing && (
                  <button
                    className={styles.deleteBtn}
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </button>
                )}
                <button className={styles.cancelBtn} onClick={handleClose}>
                  {logId ? 'Cancel' : 'Skip'}
                </button>
                <button
                  className={`${styles.saveBtn} ${saveError ? styles.saveError : ''}`}
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete decision"
        message="This decision log entry will be permanently deleted. This cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>,
    document.body
  )
}
