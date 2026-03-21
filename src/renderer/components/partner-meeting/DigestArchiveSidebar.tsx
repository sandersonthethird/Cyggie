/**
 * DigestArchiveSidebar — left sidebar listing past and current digest weeks.
 * Active week has a dot indicator. Clicking an archived week navigates to it.
 */

import type { PartnerMeetingDigestSummary } from '../../../shared/types/partner-meeting'
import styles from './DigestArchiveSidebar.module.css'

interface DigestArchiveSidebarProps {
  digests: PartnerMeetingDigestSummary[]
  selectedId: string
  onSelect: (id: string) => void
}

function formatWeekOf(weekOf: string): string {
  const date = new Date(weekOf + 'T00:00:00')
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function DigestArchiveSidebar({ digests, selectedId, onSelect }: DigestArchiveSidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>Partner Sync</div>
      <div className={styles.list}>
        {digests.map(d => (
          <button
            key={d.id}
            className={`${styles.item} ${d.id === selectedId ? styles.active : ''}`}
            onClick={() => onSelect(d.id)}
          >
            <div className={styles.weekOf}>
              {d.status === 'active' && <span className={styles.activeDot} />}
              {formatWeekOf(d.weekOf)}
            </div>
            <div className={styles.meta}>
              {d.itemCount} item{d.itemCount !== 1 ? 's' : ''}
              {d.status === 'archived' && <span className={styles.archived}>Archived</span>}
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}
