import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import Dashboard from './routes/Dashboard'
import MeetingList from './routes/MeetingList' // kept for rollback
import MeetingsPage from './routes/MeetingsPage'
import MeetingDetail from './routes/MeetingDetail'
import Companies from './routes/Companies'
import CompanyDetail from './routes/CompanyDetail'
import Contacts from './routes/Contacts'
import ContactDetail from './routes/ContactDetail'
import Pipeline from './routes/Pipeline'
import Tasks from './routes/Tasks'
import RecycleBin from './routes/RecycleBin'
import Notes from './routes/Notes'
import NoteDetail, { NoteDetailLoaded } from './routes/NoteDetail'
import LiveRecording from './routes/LiveRecording'
import SearchResults from './routes/SearchResults'
import Settings from './routes/Settings'
import PartnerMeeting from './routes/PartnerMeeting'
import AIChats from './routes/AIChats'
import AIChatFullscreen from './routes/AIChatFullscreen'
import { useCalendar } from './hooks/useCalendar'
import { useRecordingStore } from './stores/recording.store'
import { usePreferencesStore } from './stores/preferences.store'
import { useAppearance } from './hooks/useAppearance'
import { AudioCaptureProvider } from './contexts/AudioCaptureContext'
import { RunsProvider } from './contexts/RunsContext'
import { EnhancementProvider } from './contexts/EnhancementContext'
import { NoticeModalProvider } from './components/common/NoticeModal'
import DevAgentRuns from './routes/DevAgentRuns'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { IPC_CHANNELS } from '../shared/constants/channels'
import { api } from './api'

// Renderer-wide fallback. Renders only when an uncaught exception bubbles
// out of every component below the root <ErrorBoundary/>. Reload is the
// recovery path — transient state (draft messages, scroll positions) is
// lost; persisted state is preserved.
function RootErrorFallback() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '12px',
        padding: '24px',
        background: 'var(--color-bg)',
        color: 'var(--color-text)',
        fontFamily: 'inherit',
      }}
      role="alert"
    >
      <h2 style={{ margin: 0, fontSize: '18px' }}>Something went wrong</h2>
      <p style={{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '13px' }}>
        Reload the app to recover. Your saved data is safe.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          padding: '8px 18px',
          background: 'var(--cv-crimson, #B91C1C)',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
          marginTop: '8px',
        }}
      >
        Reload
      </button>
    </div>
  )
}

function CalendarInit() {
  useCalendar()
  return null
}

function PreferencesInit() {
  const load = usePreferencesStore((s) => s.load)
  useEffect(() => { void load() }, [load])
  // Apply reading-appearance tokens from the synced store + keep the pre-paint
  // localStorage mirror fresh. Lives here so popout windows get it too.
  useAppearance()
  return null
}

function NotificationPermissionInit() {
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  }, [])
  return null
}

function NotificationListener() {
  const navigate = useNavigate()
  const startRecording = useRecordingStore((s) => s.startRecording)
  const isRecordingRef = useRef(useRecordingStore.getState().isRecording)

  // Keep ref in sync without re-subscribing the effect
  useEffect(() => {
    return useRecordingStore.subscribe((s) => {
      isRecordingRef.current = s.isRecording
    })
  }, [])

  useEffect(() => {
    const startFromIpc = async (payload?: { title?: string; calendarEventId?: string; meetingUrl?: string }) => {
      if (isRecordingRef.current) {
        const activeMeetingId = useRecordingStore.getState().meetingId
        if (activeMeetingId) navigate(`/meeting/${activeMeetingId}`)
        return
      }
      try {
        const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null; alreadyRecording?: boolean }>(
          IPC_CHANNELS.RECORDING_START,
          payload?.title,
          payload?.calendarEventId,
          undefined,
          payload?.meetingUrl
        )
        if (!result.alreadyRecording) {
          startRecording(result.meetingId, result.meetingPlatform)
        }
        navigate(`/meeting/${result.meetingId}`)
      } catch (err) {
        alert(`Failed to start recording: ${String(err)}`)
      }
    }

    const unsubNotification = api.on('notification:start-recording', (payload: unknown) => {
      const p = (payload as { title: string; calendarEventId?: string; meetingUrl?: string }) ?? {}
      void startFromIpc({ title: p.title, calendarEventId: p.calendarEventId, meetingUrl: p.meetingUrl })
    })

    const unsubTrayStart = api.on('recording:start-from-tray', () => {
      void startFromIpc()
    })

    return () => {
      unsubNotification()
      unsubTrayStart()
    }
  }, [navigate, startRecording])

  return null
}

export default function App() {
  const isPopOut = new URLSearchParams(window.location.search).get('popout') === 'true'
  return (
    <ErrorBoundary fallback={() => <RootErrorFallback />}>
      <NoticeModalProvider>
      <EnhancementProvider>
      <HashRouter>
        <AudioCaptureProvider>
          <RunsProvider>
          <PreferencesInit />
          {!isPopOut && <CalendarInit />}
          {!isPopOut && <NotificationPermissionInit />}
          {!isPopOut && <NotificationListener />}
          <Routes>
            {isPopOut ? (
              <>
                <Route path="/note/new" element={<NoteDetail />} />
                <Route path="/note/:id" element={<NoteDetailLoaded />} />
                <Route path="*" element={null} />
              </>
            ) : (
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/meetings" element={<MeetingsPage />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/recycle" element={<RecycleBin />} />
                <Route path="/search" element={<SearchResults />} />
                <Route path="/notes" element={<Notes />} />
                <Route path="/note/new" element={<NoteDetail />} />
                <Route path="/note/:id" element={<NoteDetailLoaded />} />
                <Route path="/recording" element={<LiveRecording />} />
                <Route path="/pipeline" element={<Pipeline />} />
                <Route path="/meeting/:id" element={<MeetingDetail />} />
                <Route path="/companies" element={<Companies />} />
                <Route path="/company/:companyId" element={<CompanyDetail />} />
                <Route path="/contacts" element={<Contacts />} />
                <Route path="/contact/:contactId" element={<ContactDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/partner-meeting" element={<PartnerMeeting />} />
                <Route path="/ai-chats" element={<AIChats />} />
                <Route path="/ai-chats/:id" element={<AIChatFullscreen />} />
                <Route path="/dev/agent-runs" element={<DevAgentRuns />} />
              </Route>
            )}
          </Routes>
          </RunsProvider>
        </AudioCaptureProvider>
      </HashRouter>
      </EnhancementProvider>
      </NoticeModalProvider>
    </ErrorBoundary>
  )
}
