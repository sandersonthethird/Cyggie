import { useEffect, useRef } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import Dashboard from './routes/Dashboard'
import MeetingList from './routes/MeetingList'
import MeetingDetail from './routes/MeetingDetail'
import Companies from './routes/Companies'
import CompanyDetail from './routes/CompanyDetail'
import Contacts from './routes/Contacts'
import ContactDetail from './routes/ContactDetail'
import Pipeline from './routes/Pipeline'
import Tasks from './routes/Tasks'
import Notes from './routes/Notes'
import NoteDetail, { NoteDetailLoaded } from './routes/NoteDetail'
import LiveRecording from './routes/LiveRecording'
import Templates from './routes/Templates'
import Settings from './routes/Settings'
import PartnerMeeting from './routes/PartnerMeeting'
import { useCalendar } from './hooks/useCalendar'
import { useRecordingStore } from './stores/recording.store'
import { usePreferencesStore } from './stores/preferences.store'
import { AudioCaptureProvider } from './contexts/AudioCaptureContext'
import { IPC_CHANNELS } from '../shared/constants/channels'
import { api } from './api'

function CalendarInit() {
  useCalendar()
  return null
}

function PreferencesInit() {
  const load = usePreferencesStore((s) => s.load)
  useEffect(() => { void load() }, [load])
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
    const unsub = api.on('notification:start-recording', async (payload: unknown) => {
      if (isRecordingRef.current) {
        const activeMeetingId = useRecordingStore.getState().meetingId
        if (activeMeetingId) navigate(`/meeting/${activeMeetingId}`)
        return
      }

      const { title, calendarEventId } = (payload as { title: string; calendarEventId?: string; meetingUrl?: string }) ?? {}

      try {
        const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null; alreadyRecording?: boolean }>(
          IPC_CHANNELS.RECORDING_START,
          title,
          calendarEventId
        )
        if (!result.alreadyRecording) {
          startRecording(result.meetingId, result.meetingPlatform)
        }
        navigate(`/meeting/${result.meetingId}`)
      } catch (err) {
        // Show a visible alert since there's no UI context here
        alert(`Failed to start recording: ${String(err)}`)
      }
    })

    return unsub
  }, [navigate, startRecording])

  return null
}

export default function App() {
  return (
    <HashRouter>
      <AudioCaptureProvider>
        <CalendarInit />
        <PreferencesInit />
        <NotificationPermissionInit />
        <NotificationListener />
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/meetings" element={<MeetingList />} />
            <Route path="/tasks" element={<Tasks />} />
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
            <Route path="/templates" element={<Templates />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/partner-meeting" element={<PartnerMeeting />} />
          </Route>
        </Routes>
      </AudioCaptureProvider>
    </HashRouter>
  )
}
