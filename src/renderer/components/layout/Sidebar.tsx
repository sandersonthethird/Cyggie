import { useCallback, useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  TrendingUp,
  Building2,
  Users,
  Calendar,
  FileText,
  CheckSquare,
  Users2,
  Settings
} from 'lucide-react'
import styles from './Sidebar.module.css'
import { useFeatureFlag } from '../../hooks/useFeatureFlags'
import { useAppStore } from '../../stores/app.store'
import { useRecordingStore } from '../../stores/recording.store'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import MiniCalendar from './MiniCalendar'
import SearchBar from '../common/SearchBar'
import type { CalendarEvent } from '../../../shared/types/calendar'
import defaultLogo from '../../assets/logo.png'
import { api } from '../../api'

export default function Sidebar() {
  const navigate = useNavigate()
  const { enabled: companiesEnabled } = useFeatureFlag('ff_companies_ui_v1')
  const [brandingLogo, setBrandingLogo] = useState<string | null>(null)

  useEffect(() => {
    api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'brandingLogoDataUrl')
      .then((val) => { if (val) setBrandingLogo(val) })
      .catch(() => { /* ignore */ })
  }, [])
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)
  const startRecording = useRecordingStore((s) => s.startRecording)

  const handleRecordEvent = useCallback(async (event: CalendarEvent) => {
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
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
      const meeting = await api.invoke<{ id: string }>(
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

  // Cmd+Shift+N → new note from anywhere
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault()
        navigate('/note/new')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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
          <LayoutDashboard size={16} strokeWidth={1.5} />
          Dashboard
        </NavLink>
        <NavLink
          to="/pipeline"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <TrendingUp size={16} strokeWidth={1.5} />
          Pipeline
        </NavLink>
        {companiesEnabled && (
          <NavLink
            to="/companies"
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          >
            <Building2 size={16} strokeWidth={1.5} />
            Companies
          </NavLink>
        )}
        {companiesEnabled && (
          <NavLink
            to="/contacts"
            className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
          >
            <Users size={16} strokeWidth={1.5} />
            Contacts
          </NavLink>
        )}
        <NavLink
          to="/meetings"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <Calendar size={16} strokeWidth={1.5} />
          Meetings
        </NavLink>
        <NavLink
          to="/notes"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <FileText size={16} strokeWidth={1.5} />
          Notes
        </NavLink>
        <NavLink
          to="/tasks"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <CheckSquare size={16} strokeWidth={1.5} />
          Tasks
        </NavLink>
        <NavLink
          to="/partner-meeting"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <Users2 size={16} strokeWidth={1.5} />
          Partner Sync
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
          <img src={brandingLogo ?? defaultLogo} alt="Logo" className={styles.logoImg} />
        </div>
        <NavLink
          to="/settings"
          className={({ isActive }) => `${styles.link} ${isActive ? styles.active : ''}`}
        >
          <Settings size={16} strokeWidth={1.5} />
          Settings
        </NavLink>
      </div>
    </nav>
  )
}
