import { useSearchParams } from 'react-router-dom'
import { useAppStore } from '../../stores/app.store'
import type { MeetingBucket } from '../../../shared/types/meeting'
import type { CompanyPipelineStage } from '../../../shared/types/company'
import type { MeetingCounts } from '../../hooks/useMeetings'
import { COMPANY_KANBAN_STAGES } from '../common/PipelineStepper'
import styles from './MeetingsRail.module.css'

const STAGE_DOT_CLASS: Record<string, string> = {
  screening:     styles.dotScreening,
  diligence:     styles.dotDiligence,
  decision:      styles.dotDecision,
  documentation: styles.dotClosed,
  portfolio:     styles.dotPortfolio,
}

interface MeetingsRailProps {
  counts: MeetingCounts
  activeBucket: MeetingBucket
  activeStage?: CompanyPipelineStage
}

const INBOX_ITEMS: { key: MeetingBucket; label: string; dotClass: string }[] = [
  { key: 'all', label: 'All meetings', dotClass: styles.dotAll },
  { key: 'today', label: 'Today', dotClass: styles.dotToday },
  { key: 'upcoming', label: 'Upcoming (7d)', dotClass: styles.dotUpcoming },
  { key: 'past', label: 'Past', dotClass: styles.dotPast },
  { key: 'unreviewed', label: 'Unreviewed', dotClass: styles.dotUnreviewed },
]

const STAGE_ITEMS: { key: CompanyPipelineStage; label: string; dotClass: string }[] = [
  ...COMPANY_KANBAN_STAGES.map((s) => ({
    key: s.value,
    label: s.label,
    dotClass: STAGE_DOT_CLASS[s.value] ?? '',
  })),
  { key: 'portfolio', label: 'Portfolio', dotClass: styles.dotPortfolio },
]

export function MeetingsRail({ counts, activeBucket, activeStage }: MeetingsRailProps) {
  const [, setSearchParams] = useSearchParams()
  const calendarConnected = useAppStore((s) => s.calendarConnected)

  const handleBucketClick = (bucket: MeetingBucket) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (bucket === 'all') next.delete('bucket')
      else next.set('bucket', bucket)
      next.delete('stage')
      return next
    })
  }

  const handleStageClick = (stage: CompanyPipelineStage) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (activeStage === stage) {
        next.delete('stage')
      } else {
        next.set('stage', stage)
        next.delete('bucket')
      }
      return next
    })
  }

  const needReviewCount = counts.unreviewed

  return (
    <div className={styles.rail}>
      <div className={styles.header}>
        <div className={styles.title}>Meetings</div>
        <div className={styles.subtitle}>
          {counts.all} total{needReviewCount > 0 ? ` · ${needReviewCount} need review` : ''}
        </div>
      </div>

      {/* Inbox section */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Inbox</div>
        {INBOX_ITEMS.map(({ key, label, dotClass }) => (
          <button
            key={key}
            className={`${styles.item} ${activeBucket === key && !activeStage ? styles.itemActive : ''}`}
            onClick={() => handleBucketClick(key)}
          >
            <span className={`${styles.dot} ${dotClass}`} />
            <span className={styles.itemLabel}>{label}</span>
            <span className={styles.itemCount}>{counts[key]}</span>
          </button>
        ))}
      </div>

      {/* Pipeline stage section */}
      <div className={styles.section}>
        <div className={styles.sectionLabel}>Pipeline stage</div>
        {STAGE_ITEMS.map(({ key, label, dotClass }) => (
          <button
            key={key}
            className={`${styles.item} ${activeStage === key ? styles.itemActive : ''}`}
            onClick={() => handleStageClick(key)}
          >
            <span className={`${styles.dot} ${dotClass}`} />
            <span className={styles.itemLabel}>{label}</span>
            <span className={styles.itemCount}>{counts.byStage[key] ?? 0}</span>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <span className={`${styles.syncDot} ${calendarConnected ? styles.syncDotConnected : styles.syncDotDisconnected}`} />
        {calendarConnected ? 'Calendar synced' : 'Calendar not connected'}
      </div>
    </div>
  )
}
