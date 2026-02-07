import type { CalendarEvent } from '../../../shared/types/calendar'
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

function getTimeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now()
  if (diff < 0) return 'now'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `in ${hours}h ${minutes % 60}m`
}

export default function CalendarBadge({ event, onRecord, onPrepare, onDismiss }: CalendarBadgeProps) {
  const isNow =
    new Date(event.startTime).getTime() <= Date.now() &&
    new Date(event.endTime).getTime() >= Date.now()

  return (
    <div
      className={`${styles.badge} ${isNow ? styles.active : ''}`}
      onClick={() => onPrepare(event)}
    >
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
      <div className={styles.header}>
        <span className={styles.time}>{formatTime(event.startTime)}</span>
        <span className={styles.until}>{getTimeUntil(event.startTime)}</span>
      </div>
      <div className={styles.title}>{event.title}</div>
      {event.platform && <span className={styles.platform}>{event.platform}</span>}
      {event.attendees.length > 0 && (
        <div className={styles.attendees}>
          {event.attendees.slice(0, 3).join(', ')}
          {event.attendees.length > 3 && ` +${event.attendees.length - 3}`}
        </div>
      )}
      <button
        className={styles.recordBtn}
        onClick={(e) => {
          e.stopPropagation()
          onRecord(event)
        }}
      >
        Record
      </button>
    </div>
  )
}
