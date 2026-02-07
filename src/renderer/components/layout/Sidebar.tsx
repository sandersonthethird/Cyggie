import { NavLink, useNavigate } from 'react-router-dom'
import styles from './Sidebar.module.css'
import { useRecordingStore } from '../../stores/recording.store'
import { useAppStore } from '../../stores/app.store'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import CalendarBadge from '../meetings/CalendarBadge'
import type { CalendarEvent } from '../../../shared/types/calendar'

export default function Sidebar() {
  const navigate = useNavigate()
  const startRecording = useRecordingStore((s) => s.startRecording)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)

  const visibleEvents = calendarEvents.filter((e) => !dismissedEventIds.has(e.id))

  const handleRecordFromCalendar = async (event: CalendarEvent) => {
    try {
      const result = await window.api.invoke<{ meetingId: string }>(
        IPC_CHANNELS.RECORDING_START,
        event.title
      )
      startRecording(result.meetingId)
      navigate(`/meeting/${result.meetingId}`)
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }

  return (
    <nav className={styles.sidebar}>
      <div className={styles.nav}>
        <NavLink
          to="/"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9776;</span>
          Meetings
        </NavLink>
        <NavLink
          to="/query"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#128269;</span>
          Query
        </NavLink>
        <NavLink
          to="/templates"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9998;</span>
          Templates
        </NavLink>
      </div>

      {calendarConnected && visibleEvents.length > 0 && (
        <div className={styles.calendar}>
          <h4 className={styles.calendarTitle}>Upcoming</h4>
          {visibleEvents.slice(0, 5).map((event) => (
            <CalendarBadge
              key={event.id}
              event={event}
              onRecord={handleRecordFromCalendar}
              onDismiss={() => dismissEvent(event.id)}
            />
          ))}
        </div>
      )}

      <div className={styles.bottom}>
        <NavLink
          to="/settings"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9881;</span>
          Settings
        </NavLink>
      </div>
    </nav>
  )
}
