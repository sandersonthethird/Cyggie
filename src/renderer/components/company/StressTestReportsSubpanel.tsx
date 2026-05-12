import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type {
  StressTestReport,
  StressTestReportSummary,
  Recommendation,
} from '../../../shared/types/stress-test-report'
import { StressTestReportViewer } from './StressTestReportViewer'
import styles from './StressTestReportsSubpanel.module.css'

interface Props {
  memoId: string
  /**
   * Bumps a counter when the parent knows a new report was just persisted
   * (post-stress-test completion). Triggers a re-fetch of the list.
   */
  refreshKey?: number
}

const REC_LABEL: Record<Recommendation, string> = {
  proceed: 'Proceed',
  proceed_with_caveats: 'Caveats',
  pass: 'Pass',
  dig_deeper: 'Dig deeper',
}

const REC_CLASS: Record<Recommendation, string> = {
  proceed: styles.recProceed,
  proceed_with_caveats: styles.recProceedCaveats,
  pass: styles.recPass,
  dig_deeper: styles.recDigDeeper,
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function StressTestReportsSubpanel({ memoId, refreshKey }: Props) {
  const [open, setOpen] = useState(false)
  const [summaries, setSummaries] = useState<StressTestReportSummary[] | null>(null)
  const [activeReport, setActiveReport] = useState<StressTestReport | null>(null)

  // Lazy-load: only fetch when the subpanel is expanded for the first time, or
  // when refreshKey changes (a new report was just persisted).
  useEffect(() => {
    if (!memoId) return
    if (!open && summaries !== null) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await api.invoke<StressTestReportSummary[]>(
          IPC_CHANNELS.STRESS_TEST_REPORT_LIST,
          memoId,
        )
        if (!cancelled) setSummaries(rows ?? [])
      } catch {
        if (!cancelled) setSummaries([])
      }
    })()
    return () => { cancelled = true }
  }, [memoId, open, refreshKey, summaries])

  // Force-refresh on refreshKey bump even when collapsed (so the count is fresh
  // when the user expands later).
  useEffect(() => {
    if (refreshKey === undefined) return
    setSummaries(null)
  }, [refreshKey])

  const openReport = useCallback(async (id: string) => {
    try {
      const full = await api.invoke<StressTestReport | null>(IPC_CHANNELS.STRESS_TEST_REPORT_GET, id)
      if (full) setActiveReport(full)
    } catch (err) {
      console.error('[stress-test-report] get failed:', err)
    }
  }, [])

  const count = summaries?.length ?? 0

  return (
    <div className={styles.container}>
      <div className={styles.header} onClick={() => setOpen(o => !o)}>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>▶</span>
        <span className={styles.title}>Stress-test reports</span>
        <span className={styles.count}>{count > 0 ? count : 'none yet'}</span>
      </div>
      {open && (
        summaries === null ? (
          <p className={styles.empty}>Loading…</p>
        ) : summaries.length === 0 ? (
          <p className={styles.empty}>No stress-tests yet — click Stress-test above to run one.</p>
        ) : (
          <ul className={styles.list}>
            {summaries.map(s => (
              <li key={s.id} className={styles.row} onClick={() => openReport(s.id)}>
                <span className={styles.date}>{formatShortDate(s.createdAt)}</span>
                <span className={`${styles.recPill} ${REC_CLASS[s.recommendation]}`}>
                  {REC_LABEL[s.recommendation]}
                </span>
                <span className={styles.summaryPreview}>{s.summary}</span>
                <span className={styles.concernCount}>{s.concernCount} concerns</span>
              </li>
            ))}
          </ul>
        )
      )}
      {activeReport && (
        <StressTestReportViewer report={activeReport} onClose={() => setActiveReport(null)} />
      )}
    </div>
  )
}
