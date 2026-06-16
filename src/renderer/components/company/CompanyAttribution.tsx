import type { CompanyDetail } from '../../../shared/types/company'
import { relativeTime, absoluteTime } from '../../utils/relative-time'
import styles from './CompanyAttribution.module.css'

interface CompanyAttributionProps {
  company: CompanyDetail
}

/**
 * Multiplayer attribution line — "Created by X · Edited by Y 2h ago".
 *
 * Firm-shared companies are edited by any teammate, so this surfaces who
 * created and who last touched the record. Names come from the local users
 * table (the current user always; teammates once the firm directory is synced);
 * when a name isn't known yet we degrade to just the timestamp rather than show
 * a raw id. Renders nothing if there's no attribution at all.
 */
export function CompanyAttribution({ company }: CompanyAttributionProps) {
  const { createdByName, updatedByName, createdAt, updatedAt } = company

  const editedTime = updatedAt || createdAt
  const hasAnything = Boolean(createdByName || updatedByName || editedTime)
  if (!hasAnything) return null

  return (
    <div className={styles.attribution}>
      {createdByName && (
        <span className={styles.part}>Created by {createdByName}</span>
      )}
      {editedTime && (
        <span className={styles.part} title={absoluteTime(editedTime)}>
          {updatedByName ? `Edited by ${updatedByName} ` : 'Updated '}
          {relativeTime(editedTime)}
        </span>
      )}
    </div>
  )
}
