import { useEffect } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import MeetingList from './routes/MeetingList'
import MeetingDetail from './routes/MeetingDetail'
import Companies from './routes/Companies'
import CompanyDetail from './routes/CompanyDetail'
import Contacts from './routes/Contacts'
import ContactDetail from './routes/ContactDetail'
import Templates from './routes/Templates'
import Settings from './routes/Settings'
import { useCalendar } from './hooks/useCalendar'
import { useRecordingStore } from './stores/recording.store'
import { AudioCaptureProvider } from './contexts/AudioCaptureContext'
import { IPC_CHANNELS } from '../shared/constants/channels'

function CalendarInit() {
  useCalendar()
  return null
}

function NotificationListener() {
  const navigate = useNavigate()
  const startRecording = useRecordingStore((s) => s.startRecording)
  const isRecording = useRecordingStore((s) => s.isRecording)
  const setError = useRecordingStore((s) => s.setError)

  useEffect(() => {
    const unsub = window.api.on('notification:start-recording', async (title: unknown) => {
      if (isRecording) return

      try {
        const result = await window.api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
          IPC_CHANNELS.RECORDING_START,
          title as string
        )
        startRecording(result.meetingId, result.meetingPlatform)
        navigate(`/meeting/${result.meetingId}`)
      } catch (err) {
        setError(String(err))
      }
    })

    return unsub
  }, [navigate, startRecording, isRecording, setError])

  return null
}

export default function App() {
  return (
    <HashRouter>
      <AudioCaptureProvider>
        <CalendarInit />
        <NotificationListener />
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<MeetingList />} />
            <Route path="/meeting/:id" element={<MeetingDetail />} />
            <Route path="/companies" element={<Companies />} />
            <Route path="/company/:companyId" element={<CompanyDetail />} />
            <Route path="/contacts" element={<Contacts />} />
            <Route path="/contact/:contactId" element={<ContactDetail />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </AudioCaptureProvider>
    </HashRouter>
  )
}
