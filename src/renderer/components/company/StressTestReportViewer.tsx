import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type {
  StressTestReport,
  Recommendation,
  Severity,
} from '../../../shared/types/stress-test-report'
import type { EvidenceRow } from '../../../shared/types/thesis'
import styles from './StressTestReportViewer.module.css'

interface Props {
  report: StressTestReport
  onClose: () => void
}

const REC_LABEL: Record<Recommendation, string> = {
  proceed: 'Proceed',
  proceed_with_caveats: 'Proceed with caveats',
  pass: 'Pass',
  dig_deeper: 'Dig deeper',
}

const REC_CLASS: Record<Recommendation, string> = {
  proceed: styles.recProceed,
  proceed_with_caveats: styles.recProceedCaveats,
  pass: styles.recPass,
  dig_deeper: styles.recDigDeeper,
}

const SEV_CLASS: Record<Severity, string> = {
  high: styles.sevHigh,
  medium: styles.sevMedium,
  low: styles.sevLow,
}

const SEV_DOT: Record<Severity, string> = {
  high: '🔴',
  medium: '🟡',
  low: '🟢',
}

function formatRelativeTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

export function StressTestReportViewer({ report, onClose }: Props) {
  // Esc closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const evidenceCritiques = report.evidence.filter(e => e.isCritique)
  const evidenceContext = report.evidence.filter(e => !e.isCritique)

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <h2 className={styles.title}>Stress-test report — {formatRelativeTime(report.createdAt)}</h2>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className={styles.body}>
          <span className={`${styles.recPill} ${REC_CLASS[report.recommendation]}`}>
            {REC_LABEL[report.recommendation]}
          </span>

          <p className={styles.summary}>{report.summary}</p>

          <h3 className={styles.sectionTitle}>
            Concerns ({report.concerns.length})
          </h3>
          <ol className={styles.concernsList}>
            {report.concerns.map(c => (
              <li key={c.n} className={styles.concernCard}>
                <div className={styles.concernHeader}>
                  <span className={styles.concernNumber}>{c.n}.</span>
                  <span className={styles.concernClaim}>{c.claim}</span>
                  <span
                    className={`${styles.severityBadge} ${SEV_CLASS[c.severity]}`}
                    title={`Severity: ${c.severity}`}
                  >
                    {SEV_DOT[c.severity]} {c.severity}
                  </span>
                </div>
                <p className={styles.concernField}>
                  <span className={styles.concernFieldLabel}>Evidence:</span>
                  {c.evidence}
                </p>
                <p className={styles.concernField}>
                  <span className={styles.concernFieldLabel}>What would change my mind:</span>
                  {c.whatWouldChangeMind}
                </p>
              </li>
            ))}
          </ol>

          {evidenceCritiques.length > 0 && (
            <>
              <h3 className={styles.sectionTitle}>
                Claim-level flags ({evidenceCritiques.length})
              </h3>
              <ul className={styles.evidenceList}>
                {evidenceCritiques.map(ev => (
                  <EvidenceItem key={`${ev.claimText}|${ev.sourceUrl ?? ev.sourceId ?? ''}`} ev={ev} critique />
                ))}
              </ul>
            </>
          )}

          {evidenceContext.length > 0 && (
            <>
              <h3 className={styles.sectionTitle}>
                Supporting evidence ({evidenceContext.length})
              </h3>
              <ul className={styles.evidenceList}>
                {evidenceContext.map(ev => (
                  <EvidenceItem key={`${ev.claimText}|${ev.sourceUrl ?? ev.sourceId ?? ''}`} ev={ev} critique={false} />
                ))}
              </ul>
            </>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.footerStats}>
            <span>${report.costEstimateUsd.toFixed(2)}</span>
            <span>{(report.durationMs / 1000).toFixed(0)}s</span>
            <span>{report.toolCallCount} tool calls</span>
          </div>
          <a className={styles.footerLink} href={`#/dev/agent-runs`} onClick={onClose}>
            View full trace →
          </a>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function EvidenceItem({ ev, critique }: { ev: EvidenceRow; critique: boolean }) {
  return (
    <li className={`${styles.evidenceItem} ${critique ? styles.evidenceCritique : ''}`}>
      <span className={styles.evidenceClaim}>{ev.claimText}</span>
      {ev.snippet && <span style={{ color: 'var(--color-text-secondary, #6b7280)' }}>{ev.snippet}</span>}
      <div className={styles.evidenceMeta}>
        <span>{ev.sourceType}</span>
        {ev.severity && critique && (
          <span className={`${styles.severityBadge} ${SEV_CLASS[ev.severity]}`}>
            {SEV_DOT[ev.severity]} {ev.severity}
          </span>
        )}
        {ev.sourceUrl && (
          <a
            href={ev.sourceUrl}
            className={styles.evidenceLink}
            target="_blank"
            rel="noreferrer"
          >
            source ↗
          </a>
        )}
        {ev.section && <span>· {ev.section}</span>}
      </div>
    </li>
  )
}
