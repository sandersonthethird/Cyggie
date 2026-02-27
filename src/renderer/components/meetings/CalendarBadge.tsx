import type { CalendarEvent } from '../../../shared/types/calendar'
import { getSingleCompanyDomain } from '../../../shared/utils/company-domain'
import styles from './CalendarBadge.module.css'

interface CalendarBadgeProps {
  event: CalendarEvent
  onRecord: (event: CalendarEvent) => void
  onPrepare: (event: CalendarEvent) => void
  onDismiss: (event: CalendarEvent) => void
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDuration(startTime: string, endTime: string): string {
  const diffMs = new Date(endTime).getTime() - new Date(startTime).getTime()
  const minutes = Math.max(0, Math.floor(diffMs / 60000))
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  return `${minutes}m`
}

export default function CalendarBadge({ event, onRecord, onPrepare, onDismiss }: CalendarBadgeProps) {
  const isNow =
    new Date(event.startTime).getTime() <= Date.now() &&
    new Date(event.endTime).getTime() >= Date.now()

  const attendeeNames = event.attendees.join(', ')
  const companyDomain = getSingleCompanyDomain(event.attendeeEmails)

  return (
    <div
      className={`${styles.card} ${isNow ? styles.active : ''}`}
      onClick={() => onPrepare(event)}
    >
      {companyDomain && (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(companyDomain)}&sz=32`}
          alt=""
          className={styles.logo}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <div className={styles.row}>
        <h3 className={styles.title}>{event.title}</h3>
        <span className={styles.time}>{formatTime(event.startTime)}</span>
      </div>
      <div className={styles.row}>
        {attendeeNames ? (
          <span className={styles.speakers}>{attendeeNames}</span>
        ) : (
          <span />
        )}
        <span className={styles.duration}>{formatDuration(event.startTime, event.endTime)}</span>
      </div>
      <button
        className={styles.dismissBtn}
        onClick={(e) => {
          e.stopPropagation()
          onDismiss(event)
        }}
        title="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
