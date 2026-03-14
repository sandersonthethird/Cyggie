import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import { useAppStore } from '../../stores/app.store'
import { useRecordingStore } from '../../stores/recording.store'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CalendarEvent } from '../../../shared/types/calendar'
import type { Meeting } from '../../../shared/types/meeting'
import styles from './Layout.module.css'

const NOTIFY_BEFORE_MS = 2 * 60 * 1000 // 2 minutes

export default function Layout() {
  const navigate = useNavigate()
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const isRecording = useRecordingStore((s) => s.isRecording)
  const startRecordingStore = useRecordingStore((s) => s.startRecording)
  const [bannerEvent, setBannerEvent] = useState<CalendarEvent | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState<Set<string>>(new Set())
  const [recordingError, setRecordingError] = useState<string | null>(null)

  // Check every 30s for meetings about to start
  useEffect(() => {
    const check = () => {
      const now = Date.now()
      const upcoming = calendarEvents.find((e) => {
        if (dismissedEventIds.has(e.id)) return false
        if (bannerDismissed.has(e.id)) return false
        const start = new Date(e.startTime).getTime()
        const timeUntil = start - now
        return timeUntil > 0 && timeUntil <= NOTIFY_BEFORE_MS
      })
      setBannerEvent(upcoming ?? null)
    }
    check()
    const id = setInterval(check, 30_000)
    return () => clearInterval(id)
  }, [calendarEvents, dismissedEventIds, bannerDismissed])

  const handleBannerRecord = useCallback(async (event: CalendarEvent) => {
    if (isRecording) return
    setBannerEvent(null)
    setBannerDismissed((prev) => new Set([...prev, event.id]))
    setRecordingError(null)
    try {
      const result = await window.api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        event.title,
        event.id
      )
      startRecordingStore(result.meetingId, result.meetingPlatform)
      navigate(`/meeting/${result.meetingId}`)
    } catch (err) {
      setRecordingError(String(err))
    }
  }, [isRecording, navigate, startRecordingStore])

  const handleBannerJoin = useCallback((event: CalendarEvent) => {
    if (event.meetingUrl) {
      window.api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, event.meetingUrl).catch(console.error)
    }
  }, [])

  const dismissBanner = useCallback((eventId: string) => {
    setBannerDismissed((prev) => new Set([...prev, eventId]))
    setBannerEvent(null)
  }, [])

  useEffect(() => {
    const focusChatInput = (): boolean => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-chat-shortcut="true"]')
      ).filter((el) => !el.disabled && el.offsetParent !== null)

      if (candidates.length === 0) return false
      const target = candidates[candidates.length - 1]
      target.focus()
      if ('selectionStart' in target && 'value' in target) {
        const end = target.value.length
        target.setSelectionRange(end, end)
      }
      return true
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (focusChatInput()) {
          event.preventDefault()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!newMenuOpen) return
    const handler = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [newMenuOpen])

  const handleNewNote = async () => {
    setNewMenuOpen(false)
    try {
      const meeting = await window.api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to create note:', err)
    }
  }

  const handleNewCompany = () => {
    setNewMenuOpen(false)
    navigate('/companies?new=1')
  }

  const handleNewContact = () => {
    setNewMenuOpen(false)
    navigate('/contacts?new=1')
  }

  const handleNewTask = () => {
    setNewMenuOpen(false)
    navigate('/tasks')
  }

  return (
    <div className={styles.layout}>
      <div className={styles.titlebar}>
        <div className={styles.titlebarControls}>
          <div className={styles.titlebarNewDropdown} ref={newMenuRef}>
            <button
              className={styles.titlebarNewBtn}
              onClick={() => setNewMenuOpen((v) => !v)}
            >
              + New
            </button>
            {newMenuOpen && (
              <div className={styles.titlebarNewMenu}>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewNote}>
                  Note
                </button>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewCompany}>
                  Company
                </button>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewContact}>
                  Contact
                </button>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewTask}>
                  Task
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className={styles.body}>
        <Sidebar />
        <div className={styles.main}>
          <div className={styles.content}>
            <Outlet />
          </div>
        </div>
      </div>
      {bannerEvent && (
        <div className={styles.meetingBanner}>
          <div className={styles.bannerInfo}>
            <span className={styles.bannerTitle}>{bannerEvent.title}</span>
            <span className={styles.bannerSub}>Starting in ~2 min</span>
          </div>
          <div className={styles.bannerActions}>
            {bannerEvent.meetingUrl && (
              <button className={styles.bannerJoinBtn} onClick={() => handleBannerJoin(bannerEvent)}>
                Join
              </button>
            )}
            {!isRecording && (
              <button className={styles.bannerRecordBtn} onClick={() => handleBannerRecord(bannerEvent)}>
                Record
              </button>
            )}
            <button className={styles.bannerDismissBtn} onClick={() => dismissBanner(bannerEvent.id)} title="Dismiss">
              ×
            </button>
          </div>
        </div>
      )}
      {recordingError && (
        <div className={styles.meetingBannerError}>
          {recordingError}
          <button className={styles.bannerDismissBtn} onClick={() => setRecordingError(null)}>×</button>
        </div>
      )}
    </div>
  )
}
