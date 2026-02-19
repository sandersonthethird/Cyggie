import { NavLink, useNavigate } from 'react-router-dom'
import styles from './Sidebar.module.css'
import { useRecordingStore } from '../../stores/recording.store'
import { useAppStore } from '../../stores/app.store'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import MiniCalendar from './MiniCalendar'
import type { CalendarEvent } from '../../../shared/types/calendar'
import type { Meeting } from '../../../shared/types/meeting'
import logo from '../../assets/logo.png'

export default function Sidebar() {
  const navigate = useNavigate()
  const startRecording = useRecordingStore((s) => s.startRecording)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)

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

  const handlePrepareFromCalendar = async (event: CalendarEvent) => {
    try {
      const meeting = await window.api.invoke<Meeting>(
        IPC_CHANNELS.MEETING_PREPARE,
        event.id,
        event.title,
        event.startTime,
        event.platform || undefined,
        event.meetingUrl || undefined,
        event.attendees,
        event.attendeeEmails
      )
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to prepare meeting:', err)
    }
  }

  const handleDismissEvent = (event: CalendarEvent) => {
    dismissEvent(event.id)
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
          to="/templates"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9998;</span>
          Templates
        </NavLink>
      </div>

      {calendarConnected && (
        <div className={styles.calendar}>
          <MiniCalendar
            calendarConnected={calendarConnected}
            dismissedEventIds={dismissedEventIds}
            storeEvents={calendarEvents}
            onRecordEvent={handleRecordFromCalendar}
            onPrepareEvent={handlePrepareFromCalendar}
            onDismissEvent={handleDismissEvent}
            onClickMeeting={(id) => navigate(`/meeting/${id}`)}
          />
        </div>
      )}

      <div className={styles.bottom}>
        <div className={styles.logo}>
          <img src={logo} alt="GORP" className={styles.logoImg} />
        </div>
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
