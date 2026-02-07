import { createContext, useContext, useRef, useEffect } from 'react'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { useRecordingStore } from '../stores/recording.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { TranscriptSegment, RecordingStatus } from '../../shared/types/recording'

type AudioCaptureValue = ReturnType<typeof useAudioCapture>

const AudioCaptureContext = createContext<AudioCaptureValue | null>(null)

export function AudioCaptureProvider({ children }: { children: React.ReactNode }) {
  const audioCapture = useAudioCapture()
  const isRecording = useRecordingStore((s) => s.isRecording)
  const isPaused = useRecordingStore((s) => s.isPaused)
  const setError = useRecordingStore((s) => s.setError)
  const addTranscriptSegment = useRecordingStore((s) => s.addTranscriptSegment)
  const setInterimSegment = useRecordingStore((s) => s.setInterimSegment)
  const setDuration = useRecordingStore((s) => s.setDuration)
  const setSpeakerCount = useRecordingStore((s) => s.setSpeakerCount)
  const startedRef = useRef(false)

  // Auto-start audio capture when recording begins
  useEffect(() => {
    if (isRecording && !startedRef.current) {
      startedRef.current = true
      audioCapture.start().catch((err) => setError(String(err)))
    }
    if (!isRecording) {
      startedRef.current = false
    }
  }, [isRecording, audioCapture, setError])

  // IPC listeners for transcript, status, and error updates
  useEffect(() => {
    const unsubTranscript = window.api.on(
      IPC_CHANNELS.RECORDING_TRANSCRIPT_UPDATE,
      (segment: unknown) => {
        const seg = segment as TranscriptSegment
        if (seg.isFinal) {
          addTranscriptSegment(seg)
          setInterimSegment(null)
        } else {
          setInterimSegment(seg)
        }
      }
    )

    const unsubStatus = window.api.on(
      IPC_CHANNELS.RECORDING_STATUS,
      (status: unknown) => {
        const s = status as RecordingStatus
        if (!s.isPaused) setDuration(s.durationSeconds)
        setSpeakerCount(s.speakerCount)
      }
    )

    const unsubError = window.api.on(IPC_CHANNELS.RECORDING_ERROR, (err: unknown) => {
      setError(String(err))
    })

    const unsubAutoStop = window.api.on(IPC_CHANNELS.RECORDING_AUTO_STOP, async () => {
      if (!useRecordingStore.getState().isRecording) return
      console.log('[AutoStop] Received auto-stop signal, stopping recording')
      try {
        audioCapture.stop()
        await window.api.invoke(IPC_CHANNELS.RECORDING_STOP)
        useRecordingStore.getState().stopRecording()
      } catch (err) {
        console.error('[AutoStop] Failed to stop recording:', err)
      }
    })

    return () => {
      unsubTranscript()
      unsubStatus()
      unsubError()
      unsubAutoStop()
    }
  }, [addTranscriptSegment, setInterimSegment, setDuration, setSpeakerCount, setError, audioCapture])

  // Duration timer — local tick for responsive updates between IPC status messages
  useEffect(() => {
    if (!isRecording || isPaused) return
    const interval = setInterval(() => {
      setDuration(Math.floor((Date.now() - (useRecordingStore.getState().startTime || Date.now())) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [isRecording, isPaused, setDuration])

  return (
    <AudioCaptureContext.Provider value={audioCapture}>
      {children}
    </AudioCaptureContext.Provider>
  )
}

export function useSharedAudioCapture() {
  const ctx = useContext(AudioCaptureContext)
  if (!ctx) throw new Error('useSharedAudioCapture must be used within AudioCaptureProvider')
  return ctx
}
