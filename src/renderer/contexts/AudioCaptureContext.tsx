import { createContext, useContext, useRef, useEffect } from 'react'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { useVideoCapture } from '../hooks/useVideoCapture'
import { useRecordingStore } from '../stores/recording.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { TranscriptSegment, RecordingStatus } from '../../shared/types/recording'
import { api } from '../api'

interface CaptureContextValue {
  audioCapture: ReturnType<typeof useAudioCapture>
  videoCapture: ReturnType<typeof useVideoCapture>
}

const AudioCaptureContext = createContext<CaptureContextValue | null>(null)

export function AudioCaptureProvider({ children }: { children: React.ReactNode }) {
  const audioCapture = useAudioCapture()
  const videoCapture = useVideoCapture()
  const isRecording = useRecordingStore((s) => s.isRecording)
  const isPaused = useRecordingStore((s) => s.isPaused)
  const startedRef = useRef(false)

  // Refs keep handlers stable: IPC listeners (registered once below) read
  // current values via *.current without re-subscribing on every render.
  // Without this, the listener effect's dep array would include hook returns
  // that change identity each render, churning api.on/api.off ~once per
  // second while recording (driven by the duration timer).
  const audioCaptureRef = useRef(audioCapture)
  const videoCaptureRef = useRef(videoCapture)
  useEffect(() => { audioCaptureRef.current = audioCapture })
  useEffect(() => { videoCaptureRef.current = videoCapture })

  // Auto-start audio capture when recording begins
  useEffect(() => {
    const store = useRecordingStore.getState()
    if (isRecording && !startedRef.current) {
      startedRef.current = true
      audioCaptureRef.current.start().catch((err) => store.setError(String(err)))
    }
    if (!isRecording) {
      startedRef.current = false
    }
  }, [isRecording])

  // IPC listeners — registered exactly once on mount. Handlers read live
  // store state via getState() and live hook values via refs, so they never
  // close over stale data despite the empty dep array.
  useEffect(() => {
    const unsubTranscript = api.on(
      IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE,
      (segment: unknown) => {
        const seg = segment as TranscriptSegment
        const store = useRecordingStore.getState()
        if (seg.isFinal) {
          store.addTranscriptSegment(seg)
          store.setInterimSegment(null)
        } else {
          store.setInterimSegment(seg)
        }
      }
    )

    const unsubStatus = api.on(
      IPC_CHANNELS.RECORDING_STATUS,
      (status: unknown) => {
        const s = status as RecordingStatus
        const store = useRecordingStore.getState()
        if (!s.isPaused) store.setDuration(s.durationSeconds)
        store.setSpeakerCount(s.speakerCount)
        if (s.channelMode) store.setChannelMode(s.channelMode)
      }
    )

    const unsubError = api.on(IPC_CHANNELS.RECORDING_ERROR, (err: unknown) => {
      useRecordingStore.getState().setError(String(err))
    })

    const unsubAutoStop = api.on(IPC_CHANNELS.RECORDING_AUTO_STOP, async () => {
      const store = useRecordingStore.getState()
      if (!store.isRecording) return
      console.log('[AutoStop] Received auto-stop signal, stopping recording')
      const meetingId = store.meetingId
      try {
        if (videoCaptureRef.current.isVideoRecording) {
          await videoCaptureRef.current.stop()
        }
        audioCaptureRef.current.stop()
        await api.invoke(IPC_CHANNELS.RECORDING_STOP)
        useRecordingStore.getState().stopRecording()
        if (meetingId) useRecordingStore.getState().markAutoStopped(meetingId)
      } catch (err) {
        console.error('[AutoStop] Failed to stop recording:', err)
      }
    })

    const unsubTrayStop = api.on('recording:stop-from-tray', async () => {
      const store = useRecordingStore.getState()
      if (!store.isRecording) return
      try {
        if (videoCaptureRef.current.isVideoRecording) {
          await videoCaptureRef.current.stop()
        }
        audioCaptureRef.current.stop()
        await api.invoke(IPC_CHANNELS.RECORDING_STOP)
        useRecordingStore.getState().stopRecording()
      } catch (err) {
        console.error('[Tray] Failed to stop recording:', err)
      }
    })


    // Video finalize events — main process runs ffmpeg finalization in the
    // background after VIDEO_STOP returns, then broadcasts one of these.
    const unsubVideoFinalized = api.on(IPC_CHANNELS.VIDEO_FINALIZED, (payload: unknown) => {
      const p = payload as { meetingId: string; filename: string }
      console.log(`[VideoFinalize] Finalized ${p.meetingId} → ${p.filename}`)
      useRecordingStore.getState().markVideoFinalized(p.meetingId)
    })

    const unsubVideoFinalizeError = api.on(IPC_CHANNELS.VIDEO_FINALIZE_ERROR, (payload: unknown) => {
      const p = payload as { meetingId: string; error: string }
      console.error(`[VideoFinalize] Failed for ${p.meetingId}:`, p.error)
      useRecordingStore.getState().setError(`Video recording failed to save: ${p.error}`)
    })

    // Recording finalize events — main process runs Deepgram finalize +
    // transcript assembly + DB write in the background after RECORDING_STOP
    // returns optimistically. The renderer waits for this signal before
    // reloading the meeting (transcript-dependent UI) and running
    // auto-enhance (summary generation needs the transcript in the DB).
    const unsubRecordingFinalized = api.on(IPC_CHANNELS.RECORDING_FINALIZED, (payload: unknown) => {
      const p = payload as { meetingId: string; durationSeconds: number }
      console.log(`[RecordingFinalize] Finalized ${p.meetingId} (${p.durationSeconds}s)`)
      useRecordingStore.getState().markRecordingFinalized(p.meetingId)
    })

    const unsubRecordingFinalizeError = api.on(IPC_CHANNELS.RECORDING_FINALIZE_ERROR, (payload: unknown) => {
      const p = payload as { meetingId: string; error: string }
      console.error(`[RecordingFinalize] Failed for ${p.meetingId}:`, p.error)
      useRecordingStore.getState().setError(`Transcript finalization failed: ${p.error}`)
    })

    return () => {
      unsubTranscript()
      unsubStatus()
      unsubError()
      unsubAutoStop()
      unsubTrayStop()
      unsubVideoFinalized()
      unsubVideoFinalizeError()
      unsubRecordingFinalized()
      unsubRecordingFinalizeError()
    }
  }, [])

  // Duration timer — local tick for responsive updates between IPC status messages
  useEffect(() => {
    if (!isRecording || isPaused) return
    const interval = setInterval(() => {
      const store = useRecordingStore.getState()
      store.setDuration(Math.floor((Date.now() - (store.startTime || Date.now())) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [isRecording, isPaused])

  return (
    <AudioCaptureContext.Provider value={{ audioCapture, videoCapture }}>
      {children}
    </AudioCaptureContext.Provider>
  )
}

export function useSharedAudioCapture() {
  const ctx = useContext(AudioCaptureContext)
  if (!ctx) throw new Error('useSharedAudioCapture must be used within AudioCaptureProvider')
  return ctx.audioCapture
}

export function useSharedVideoCapture() {
  const ctx = useContext(AudioCaptureContext)
  if (!ctx) throw new Error('useSharedVideoCapture must be used within AudioCaptureProvider')
  return ctx.videoCapture
}
