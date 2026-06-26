import { useNavigate } from 'react-router-dom'
import type { ContactMeetingRef } from '../../../shared/types/contact'
import { parseToDate } from '../../utils/format'
import { useVoiceLine } from '../../hooks/useVoice'
import styles from './ContactMeetings.module.css'

interface ContactMeetingsProps {
  meetings: ContactMeetingRef[]
  className?: string
}

export function ContactMeetings({ meetings, className }: ContactMeetingsProps) {
  const navigate = useNavigate()
  const emptyLine = useVoiceLine('emptyState', 'meetings')

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {meetings.length === 0 && (
        <div className={styles.empty}>{emptyLine}</div>
      )}
      {meetings.map((meeting) => {
        const isCalendarOnly = meeting.id.startsWith('cal:')
        return (
          <div
            key={meeting.id}
            className={`${styles.meeting} ${isCalendarOnly ? styles.calendarMeeting : ''}`}
            onClick={() => { if (!isCalendarOnly) navigate(`/meeting/${meeting.id}`) }}
          >
            <div className={styles.title}>{meeting.title || 'Untitled'}</div>
            <div className={styles.meta}>
              <span className={styles.date}>
                {parseToDate(meeting.date).toLocaleDateString(undefined, {
                  month: 'short', day: 'numeric', year: 'numeric'
                })}
              </span>
              {meeting.status && meeting.status !== 'calendar' && (
                <span className={styles.status}>{meeting.status}</span>
              )}
              {isCalendarOnly && <span className={styles.calendarTag}>Calendar</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
