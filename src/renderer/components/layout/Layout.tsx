import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useMatch, useNavigate } from 'react-router-dom'
import Sidebar from './Sidebar'
import { ChatPanelRoot } from '../chat-panel/ChatPanelRoot'
import { AIChatPanel } from '../chat-panel/AIChatPanel'
import { ChatToggle } from '../chat-panel/ChatToggle'
import { PanelOutletProvider } from '../chat-panel/PanelOutletContext'
import { useAppStore } from '../../stores/app.store'
import { useRecordingStore } from '../../stores/recording.store'
import { useChatStore } from '../../stores/chat.store'
import { useChatPanelStore } from '../../stores/chat-panel.store'
import { useSidebarMode } from '../../hooks/useSidebarMode'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useFirmTemplate } from '../../hooks/useFirmTemplate'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CalendarEvent } from '../../../shared/types/calendar'
import type { Meeting } from '../../../shared/types/meeting'
import TitlebarDateChip from './TitlebarDateChip'
import styles from './Layout.module.css'
import { api } from '../../api'

const NOTIFY_BEFORE_MS = 2 * 60 * 1000 // 2 minutes

export default function Layout() {
  const navigate = useNavigate()
  // Idempotent, best-effort per-device firm-template seed (default views/labels/
  // field options). Resolves to `vc` until firms.template_id rides the token.
  useFirmTemplate()
  const { mode: sidebarMode } = useSidebarMode()
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const isRecording = useRecordingStore((s) => s.isRecording)
  const recordingMeetingId = useRecordingStore((s) => s.meetingId)
  const startRecordingStore = useRecordingStore((s) => s.startRecording)
  const meetingMatch = useMatch('/meeting/:id')
  const [bannerEvent, setBannerEvent] = useState<CalendarEvent | null>(null)
  const [bannerDismissed, setBannerDismissed] = useState<Set<string>>(new Set())
  const [recordingError, setRecordingError] = useState<string | null>(null)

  // Refs let the 30s interval read live values without re-creating the interval
  // every time the inputs change. The interval is mounted once and reads from
  // *.current; mutations elsewhere update the refs via the sync effects below.
  const calendarEventsRef = useRef(calendarEvents)
  const dismissedEventIdsRef = useRef(dismissedEventIds)
  const bannerDismissedRef = useRef(bannerDismissed)
  useEffect(() => { calendarEventsRef.current = calendarEvents }, [calendarEvents])
  useEffect(() => { dismissedEventIdsRef.current = dismissedEventIds }, [dismissedEventIds])
  useEffect(() => { bannerDismissedRef.current = bannerDismissed }, [bannerDismissed])

  const checkUpcomingMeeting = useCallback(() => {
    const now = Date.now()
    const upcoming = calendarEventsRef.current.find((e) => {
      if (dismissedEventIdsRef.current.has(e.id)) return false
      if (bannerDismissedRef.current.has(e.id)) return false
      const start = new Date(e.startTime).getTime()
      const timeUntil = start - now
      return timeUntil > 0 && timeUntil <= NOTIFY_BEFORE_MS
    })
    setBannerEvent(upcoming ?? null)
  }, [])

  // Re-check synchronously whenever inputs change, so the banner is responsive
  // to dismissals and new calendar events without waiting up to 30s.
  useEffect(() => { checkUpcomingMeeting() }, [calendarEvents, dismissedEventIds, bannerDismissed, checkUpcomingMeeting])

  // 30s background poll — set up once, never re-created.
  useEffect(() => {
    const id = setInterval(checkUpcomingMeeting, 30_000)
    return () => clearInterval(id)
  }, [checkUpcomingMeeting])

  const handleBannerRecord = useCallback(async (event: CalendarEvent) => {
    if (isRecording) return
    setBannerEvent(null)
    setBannerDismissed((prev) => new Set([...prev, event.id]))
    setRecordingError(null)
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
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
      api.invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL_URL, event.meetingUrl).catch(console.error)
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
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
        // ⌘J toggles the AI chat panel. While popped (full-screen route),
        // ⌘J navigates back to returnTo and closes.
        const panel = useChatPanelStore.getState()
        if (panel.popped) {
          panel.setPopped(false)
          panel.setOpen(false)
          if (panel.returnTo) navigate(panel.returnTo)
        } else {
          panel.toggleOpen()
        }
        event.preventDefault()
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'h') {
        // ⌘H opens the panel in switcher (recents) mode.
        const panel = useChatPanelStore.getState()
        if (!panel.isOpen) panel.setOpen(true)
        panel.setMode(panel.mode === 'switcher' ? 'thread' : 'switcher')
        event.preventDefault()
      } else if (event.key === 'Escape') {
        // Esc closes the panel only when no input is focused (or composer is empty).
        const panel = useChatPanelStore.getState()
        if (!panel.isOpen) return
        const active = document.activeElement as HTMLElement | null
        const inEditable =
          active &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable)
        if (inEditable) {
          // Inside the composer textarea: only close if it's empty.
          if (active && 'value' in active && (active as HTMLInputElement | HTMLTextAreaElement).value.length > 0) return
        }
        panel.setOpen(false)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate])

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

  const handleNewMeeting = async () => {
    setNewMenuOpen(false)
    try {
      const meeting = await api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      console.error('Failed to create meeting:', err)
    }
  }

  const handleNewNote = () => {
    setNewMenuOpen(false)
    navigate('/notes?new=1')
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

  // The chat panel always floats over the content as an absolute overlay — it
  // never takes a grid column, so opening it never reflows/compresses the page.
  // Desktop: resizable (store width), no dimming scrim, dashboard stays live.
  // Narrow: fixed-width overlay with a dimming backdrop that taps to close.
  const panelIsOpen = useChatPanelStore((s) => s.isOpen)
  const panelPopped = useChatPanelStore((s) => s.popped)
  const panelWidth = useChatPanelStore((s) => s.width)
  const isNarrow = useMediaQuery('(max-width: 1024px)')
  const closePanel = useChatPanelStore((s) => s.setOpen)

  // Presence state machine — keep the panel mounted through its slide-out:
  //
  //   wantOpen=true  ──► render=true, closing=false   (slide-IN via .panelOverlay)
  //   wantOpen=false ─► closing=true (slide-OUT)  ──[220ms]──► render=false
  //        (prefers-reduced-motion: skip the 220ms, unmount immediately)
  //
  const wantPanel = panelIsOpen && !panelPopped
  const [renderPanel, setRenderPanel] = useState(wantPanel)
  const [panelClosing, setPanelClosing] = useState(false)
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  useEffect(() => {
    if (wantPanel) {
      setRenderPanel(true)
      setPanelClosing(false)
      return
    }
    if (!renderPanel) return // nothing mounted → nothing to animate out
    if (reduceMotion) {
      setRenderPanel(false) // skip exit animation
      return
    }
    setPanelClosing(true)
    const t = setTimeout(() => {
      setRenderPanel(false)
      setPanelClosing(false)
    }, 220)
    return () => clearTimeout(t)
    // renderPanel intentionally omitted: re-running on its own change would
    // re-arm the close timer; we only react to want/motion transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantPanel, reduceMotion])

  return (
    <div
      className={`${styles.layout} ${sidebarMode === 'collapsed' ? styles.sidebarCollapsed : ''}`}
      style={{
        '--sidebar-width': sidebarMode === 'collapsed' ? 'var(--sidebar-width-collapsed)' : '240px',
        // Panel is an absolute overlay now; the grid's third column stays empty.
        '--panel-width': '0px',
      } as React.CSSProperties}
    >
      <div className={styles.titlebar}>
        <div className={styles.titlebarBrand}>Cyggie</div>
        <div className={styles.titlebarControls}>
          <TitlebarDateChip />
          <div className={styles.titlebarNewDropdown} ref={newMenuRef}>
            <button
              className={styles.titlebarNewBtn}
              onClick={() => setNewMenuOpen((v) => !v)}
            >
              + New
            </button>
            {newMenuOpen && (
              <div className={styles.titlebarNewMenu}>
                <button className={styles.titlebarNewMenuItem} onClick={handleNewMeeting}>
                  Meeting
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
                <button className={styles.titlebarNewMenuItem} onClick={handleNewNote}>
                  Note
                </button>
              </div>
            )}
          </div>
          <ChatToggle />
        </div>
      </div>
      <PanelOutletProvider>
        <ChatPanelRoot />
        <div className={styles.body}>
          <Sidebar />
          <div className={styles.main}>
            <div className={styles.content}>
              <Outlet />
            </div>
          </div>
          {renderPanel && (
            <AIChatPanel
              closing={panelClosing}
              dimmed={isNarrow}
              resizable={!isNarrow}
              width={isNarrow ? undefined : panelWidth}
              onBackdropTap={isNarrow ? () => closePanel(false) : undefined}
            />
          )}
        </div>
      </PanelOutletProvider>
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
      {isRecording && recordingMeetingId && meetingMatch?.params.id !== recordingMeetingId && (
        <div className={`${styles.meetingBanner} ${styles.recordingBanner}`}>
          <span className={styles.recordingDot} />
          <span className={styles.bannerRecordingText}>Recording in progress</span>
          <button
            className={styles.bannerRecordBtn}
            onClick={() => navigate(`/meeting/${recordingMeetingId}`)}
          >
            Return to meeting →
          </button>
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
