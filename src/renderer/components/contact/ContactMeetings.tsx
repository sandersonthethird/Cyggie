import { useNavigate } from 'react-router-dom'
import type { ContactMeetingRef } from '../../../shared/types/contact'
import styles from './ContactMeetings.module.css'

interface ContactMeetingsProps {
  meetings: ContactMeetingRef[]
  className?: string
}

export function ContactMeetings({ meetings, className }: ContactMeetingsProps) {
  const navigate = useNavigate()

  return (
    <div className={`${styles.root} ${className ?? ''}`}>
      {meetings.length === 0 && (
        <div className={styles.empty}>No meetings found.</div>
      )}
      {meetings.map((meeting) => (
        <div
          key={meeting.id}
          className={styles.meeting}
          onClick={() => navigate(`/meeting/${meeting.id}`)}
        >
          <div className={styles.title}>{meeting.title || 'Untitled'}</div>
          <div className={styles.meta}>
            <span className={styles.date}>
              {new Date(meeting.date).toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric'
              })}
            </span>
            {meeting.status && <span className={styles.status}>{meeting.status}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
