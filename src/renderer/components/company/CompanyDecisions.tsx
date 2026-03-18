import { useCallback, useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CompanyDecisionLog } from '../../../shared/types/company'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import type { SavedDecisionRef } from '../crm/DecisionLogModal'
import styles from './CompanyDecisions.module.css'

interface CompanyDecisionsProps {
  companyId: string
}

const SYSTEM_DECISION_TYPES = new Set(['Stage Change', 'Pipeline Exit'])

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

function daysBetween(a: string, b: string): number {
  const msPerDay = 1000 * 60 * 60 * 24
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay)
}

export function CompanyDecisions({ companyId }: CompanyDecisionsProps) {
  const [logs, setLogs] = useState<CompanyDecisionLog[]>([])
  const [loaded, setLoaded] = useState(false)
  const [modalLogId, setModalLogId] = useState<string | undefined>(undefined)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    setLoaded(false)
    window.api
      .invoke<CompanyDecisionLog[]>(IPC_CHANNELS.COMPANY_DECISION_LOG_LIST, companyId)
      .then((data) => setLogs(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoaded(true))
  }, [companyId])

  const handleSaved = useCallback((saved: SavedDecisionRef) => {
    setLogs((prev) => {
      const existing = prev.findIndex((l) => l.id === saved.id)
      if (existing >= 0) {
        return prev.map((l) =>
          l.id === saved.id
            ? { ...l, decisionType: saved.decisionType, decisionDate: saved.decisionDate, decisionOwner: saved.decisionOwner }
            : l
        )
      }
      // Refetch to get complete data
      window.api
        .invoke<CompanyDecisionLog[]>(IPC_CHANNELS.COMPANY_DECISION_LOG_LIST, companyId)
        .then((data) => setLogs(Array.isArray(data) ? data : []))
        .catch(console.error)
      return prev
    })
    setShowModal(false)
    setModalLogId(undefined)
  }, [companyId])

  const handleDeleted = useCallback((deletedId: string) => {
    setLogs((prev) => prev.filter((l) => l.id !== deletedId))
    setShowModal(false)
    setModalLogId(undefined)
  }, [])

  // Pipeline history: Stage Change / Pipeline Exit entries, sorted ascending
  const stageEntries = logs
    .filter((l) => SYSTEM_DECISION_TYPES.has(l.decisionType))
    .slice()
    .sort((a, b) => a.decisionDate.localeCompare(b.decisionDate))

  // User decisions (excluding system entries), already sorted DESC from repo
  const userDecisions = logs.filter((l) => !SYSTEM_DECISION_TYPES.has(l.decisionType))

  if (!loaded) return <div className={styles.loading}>Loading…</div>

  return (
    <div className={styles.root}>
      {/* Pipeline History */}
      {stageEntries.length > 0 && (
        <div className={styles.pipelineSection}>
          <div className={styles.sectionTitle}>Pipeline History</div>
          <div className={styles.pipelineTimeline}>
            {stageEntries.map((entry, i) => {
              const next = stageEntries[i + 1]
              const durationDays = next ? daysBetween(entry.decisionDate, next.decisionDate) : null
              const isCurrent = i === stageEntries.length - 1
              // Extract stage name from rationale: "Moved from X to Y" or "Removed from pipeline (was: X)"
              const stageName = entry.rationale[0]
                ?.match(/to (\w+)$/)?.[1]
                ?? entry.rationale[0]?.match(/was: (\w+)/)?.[1]
                ?? entry.decisionType

              return (
                <span key={entry.id} className={styles.pipelineStep}>
                  <span className={`${styles.stageName} ${isCurrent ? styles.stageCurrent : ''}`}>
                    {stageName}
                  </span>
                  {durationDays !== null && (
                    <span className={styles.stageDuration}>→ {durationDays}d →</span>
                  )}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {/* Decision Cards Header */}
      <div className={styles.decisionsHeader}>
        <div className={styles.sectionTitle}>Decisions</div>
        <button
          className={styles.addBtn}
          onClick={() => { setModalLogId(undefined); setShowModal(true) }}
        >
          + Log decision
        </button>
      </div>

      {userDecisions.length === 0 && stageEntries.length === 0 && (
        <div className={styles.empty}>No decisions or pipeline history yet.</div>
      )}
      {userDecisions.length === 0 && stageEntries.length > 0 && (
        <div className={styles.empty}>No decisions logged yet.</div>
      )}

      {userDecisions.map((log) => (
        <div
          key={log.id}
          className={`${styles.card} ${styles.clickable}`}
          onClick={() => { setModalLogId(log.id); setShowModal(true) }}
        >
          <div className={styles.cardHeader}>
            <span className={styles.decisionType}>{log.decisionType}</span>
            <span className={styles.cardMeta}>
              {formatDate(log.decisionDate)}
              {log.decisionOwner && <> · {log.decisionOwner}</>}
            </span>
          </div>
          {(log.amountApproved || log.targetOwnership) && (
            <div className={styles.cardChips}>
              {log.amountApproved && (
                <span className={styles.chip}>{log.amountApproved}</span>
              )}
              {log.targetOwnership && (
                <span className={styles.chip}>
                  {log.targetOwnership}{log.moreIfPossible ? ' (more if possible)' : ''}
                </span>
              )}
              {log.structure && (
                <span className={styles.chip}>{log.structure}</span>
              )}
            </div>
          )}
          {log.rationale.length > 0 && (
            <ul className={styles.rationaleList}>
              {log.rationale.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
          {log.nextSteps.length > 0 && (
            <div className={styles.nextSteps}>
              {log.nextSteps.map((s, i) => (
                <div key={i} className={styles.nextStep}>
                  <span className={styles.nextStepWhat}>{s.what}</span>
                  {s.byWhom && <span className={styles.nextStepMeta}> — {s.byWhom}</span>}
                  {s.dueDate && <span className={styles.nextStepMeta}> ({s.dueDate})</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {showModal && (
        <DecisionLogModal
          companyId={companyId}
          logId={modalLogId}
          onClose={() => { setShowModal(false); setModalLogId(undefined) }}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}
