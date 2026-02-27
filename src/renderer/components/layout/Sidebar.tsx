import { useCallback } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import styles from './Sidebar.module.css'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import { useAppStore } from '../../stores/app.store'
import { useRecordingStore } from '../../stores/recording.store'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import MiniCalendar from './MiniCalendar'
import SearchBar from '../common/SearchBar'
import type { CalendarEvent } from '../../../shared/types/calendar'
import logo from '../../assets/logo.png'

export default function Sidebar() {
  const navigate = useNavigate()
  const { enabled: companiesEnabled } = useFeatureFlag('ff_companies_ui_v1')
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)
  const startRecording = useRecordingStore((s) => s.startRecording)

  const handleRecordEvent = useCallback(async (event: CalendarEvent) => {
    try {
      const result = await window.api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        event.title,
        event.id
      )
      startRecording(result.meetingId, result.meetingPlatform)
      navigate(`/meeting/${result.meetingId}`)
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }, [navigate, startRecording])

  const handlePrepareEvent = useCallback(async (event: CalendarEvent) => {
    try {
      const meeting = await window.api.invoke<{ id: string }>(
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
  }, [navigate])

  const handleDismissEvent = useCallback((event: CalendarEvent) => {
    dismissEvent(event.id)
  }, [dismissEvent])

  const handleClickMeeting = useCallback((meetingId: string) => {
    navigate(`/meeting/${meetingId}`)
  }, [navigate])

  return (
    <nav className={styles.sidebar}>
      <div className={styles.searchSection}>
        <SearchBar placeholder="Search" />
      </div>

      <div className={styles.nav}>
        <NavLink
          to="/"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          end
        >
          <span className={styles.icon}>&#127968;</span>
          Dashboard
        </NavLink>
        <NavLink
          to="/pipeline"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#128202;</span>
          Pipeline
        </NavLink>
        {companiesEnabled && (
          <NavLink
            to="/companies"
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          >
            <span className={styles.icon}>&#127970;</span>
            Companies
          </NavLink>
        )}
        {companiesEnabled && (
          <NavLink
            to="/contacts"
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          >
            <span className={styles.icon}>&#128101;</span>
            Contacts
          </NavLink>
        )}
        <NavLink
          to="/meetings"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <span className={styles.icon}>&#9776;</span>
          Meetings
        </NavLink>
      </div>

      {calendarConnected && (
        <div className={styles.calendarSection}>
          <MiniCalendar
            calendarConnected={calendarConnected}
            dismissedEventIds={dismissedEventIds}
            storeEvents={calendarEvents}
            onRecordEvent={handleRecordEvent}
            onPrepareEvent={handlePrepareEvent}
            onDismissEvent={handleDismissEvent}
            onClickMeeting={handleClickMeeting}
          />
        </div>
      )}

      <div className={styles.bottom}>
        <div className={styles.logoBlock}>
          <img src={logo} alt="Cyggie" className={styles.logoImg} />
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
