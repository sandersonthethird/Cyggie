import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { ContactDecisionLog } from '../../../shared/types/contact'
import type { CompanyDecisionLog } from '../../../shared/types/company'
import { DecisionLogModal } from '../crm/DecisionLogModal'
import type { SavedDecisionRef } from '../crm/DecisionLogModal'
import styles from './ContactDecisions.module.css'

interface ContactDecisionsProps {
  contactId: string
  primaryCompanyId: string | null
  primaryCompanyName: string | null
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric'
  })
}

export function ContactDecisions({ contactId, primaryCompanyId, primaryCompanyName }: ContactDecisionsProps) {
  const [contactLogs, setContactLogs] = useState<ContactDecisionLog[]>([])
  const [companyLogs, setCompanyLogs] = useState<CompanyDecisionLog[]>([])
  const [loaded, setLoaded] = useState(false)

  // Modal state
  const [modalMode, setModalMode] = useState<'contact' | 'company' | null>(null)
  const [modalLogId, setModalLogId] = useState<string | undefined>(undefined)

  useEffect(() => {
    setLoaded(false)
    const promises: [Promise<ContactDecisionLog[]>, Promise<CompanyDecisionLog[]>] = [
      window.api.invoke<ContactDecisionLog[]>(IPC_CHANNELS.CONTACT_DECISION_LOG_LIST, contactId)
        .catch(() => []),
      primaryCompanyId
        ? window.api.invoke<CompanyDecisionLog[]>(IPC_CHANNELS.COMPANY_DECISION_LOG_LIST, primaryCompanyId)
            .catch(() => [])
        : Promise.resolve([])
    ]
    Promise.allSettled(promises).then((results) => {
      const [contactResult, companyResult] = results
      setContactLogs(contactResult.status === 'fulfilled' ? contactResult.value : [])
      setCompanyLogs(companyResult.status === 'fulfilled' ? companyResult.value : [])
      setLoaded(true)
    })
  }, [contactId, primaryCompanyId])

  const handleContactSaved = useCallback((saved: SavedDecisionRef) => {
    setContactLogs((prev) => {
      const existing = prev.findIndex((l) => l.id === saved.id)
      if (existing >= 0) {
        return prev.map((l) =>
          l.id === saved.id
            ? { ...l, decisionType: saved.decisionType, decisionDate: saved.decisionDate, decisionOwner: saved.decisionOwner }
            : l
        )
      }
      // Refetch to get full object
      window.api
        .invoke<ContactDecisionLog[]>(IPC_CHANNELS.CONTACT_DECISION_LOG_LIST, contactId)
        .then((data) => setContactLogs(Array.isArray(data) ? data : []))
        .catch(console.error)
      return prev
    })
    setModalMode(null)
    setModalLogId(undefined)
  }, [contactId])

  const handleContactDeleted = useCallback((deletedId: string) => {
    setContactLogs((prev) => prev.filter((l) => l.id !== deletedId))
    setModalMode(null)
    setModalLogId(undefined)
  }, [])

  const handleCompanySaved = useCallback((saved: SavedDecisionRef) => {
    setCompanyLogs((prev) =>
      prev.map((l) =>
        l.id === saved.id
          ? { ...l, decisionType: saved.decisionType, decisionDate: saved.decisionDate, decisionOwner: saved.decisionOwner }
          : l
      )
    )
    setModalMode(null)
    setModalLogId(undefined)
  }, [])

  const handleCompanyDeleted = useCallback((deletedId: string) => {
    setCompanyLogs((prev) => prev.filter((l) => l.id !== deletedId))
    setModalMode(null)
    setModalLogId(undefined)
  }, [])

  if (!loaded) return <div className={styles.loading}>Loading…</div>

  return (
    <div className={styles.root}>
      {/* Section 1: Contact decisions */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Decisions</div>
          <button
            className={styles.addBtn}
            onClick={() => { setModalMode('contact'); setModalLogId(undefined) }}
          >
            + Log decision
          </button>
        </div>

        {contactLogs.length === 0 && (
          <div className={styles.empty}>No decisions logged yet.</div>
        )}

        {contactLogs.map((log) => (
          <div
            key={log.id}
            className={`${styles.card} ${styles.clickable}`}
            onClick={() => { setModalMode('contact'); setModalLogId(log.id) }}
          >
            <div className={styles.cardHeader}>
              <span className={styles.decisionType}>{log.decisionType}</span>
              <span className={styles.cardMeta}>
                {formatDate(log.decisionDate)}
                {log.decisionOwner && <> · {log.decisionOwner}</>}
              </span>
            </div>
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
      </div>

      {/* Section 2: Company decisions (only if primary company exists) */}
      {primaryCompanyId && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>
              Company:{' '}
              <Link to={`/company/${primaryCompanyId}`} className={styles.companyLink}>
                {primaryCompanyName ?? primaryCompanyId}
              </Link>
            </div>
          </div>

          {companyLogs.length === 0 && (
            <div className={styles.empty}>No company decisions yet.</div>
          )}

          {companyLogs.map((log) => (
            <div
              key={log.id}
              className={`${styles.card} ${styles.clickable}`}
              onClick={() => { setModalMode('company'); setModalLogId(log.id) }}
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
                  {log.amountApproved && <span className={styles.chip}>{log.amountApproved}</span>}
                  {log.targetOwnership && (
                    <span className={styles.chip}>
                      {log.targetOwnership}{log.moreIfPossible ? ' (more if possible)' : ''}
                    </span>
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
        </div>
      )}

      {/* Modals */}
      {modalMode === 'contact' && (
        <DecisionLogModal
          contactId={contactId}
          logId={modalLogId}
          onClose={() => { setModalMode(null); setModalLogId(undefined) }}
          onSaved={handleContactSaved}
          onDeleted={handleContactDeleted}
        />
      )}
      {modalMode === 'company' && primaryCompanyId && (
        <DecisionLogModal
          companyId={primaryCompanyId}
          logId={modalLogId}
          onClose={() => { setModalMode(null); setModalLogId(undefined) }}
          onSaved={handleCompanySaved}
          onDeleted={handleCompanyDeleted}
        />
      )}
    </div>
  )
}
