import { useCallback, useEffect, useRef, useState } from 'react'
import { useRecordingStore } from '../stores/recording.store'
import { useSharedAudioCapture } from '../contexts/AudioCaptureContext'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import styles from './LiveRecording.module.css'
import { api } from '../api'

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts = []
  if (h > 0) parts.push(String(h).padStart(2, '0'))
  parts.push(String(m).padStart(2, '0'))
  parts.push(String(s).padStart(2, '0'))
  return parts.join(':')
}

export default function LiveRecording() {
  const {
    isRecording,
    isPaused,
    duration,
    liveTranscript,
    interimSegment,
    speakerCount,
    error,
    startRecording,
    stopRecording,
    pauseRecording,
    resumeRecording,
    setError
  } = useRecordingStore()

  const audioCapture = useSharedAudioCapture()
  const { hasSystemAudio } = audioCapture
  const transcriptScrollRef = useRef<HTMLDivElement>(null)
  const stuckToBottomRef = useRef(true)
  const [audioFlow, setAudioFlow] = useState<{ state: 'flowing' | 'stalled'; stalledForMs: number } | null>(null)
  const [micState, setMicState] = useState<'ok' | 'muted' | 'ended'>('ok')

  useEffect(() => {
    if (!isRecording) {
      setAudioFlow(null)
      setMicState('ok')
      return
    }
    const unsubFlow = api.on(
      IPC_CHANNELS.RECORDING_AUDIO_FLOW_STATUS,
      (payload: unknown) => {
        const p = payload as { state: 'flowing' | 'stalled'; stalledForMs: number }
        setAudioFlow(p)
      }
    )
    const unsubMic = api.on(
      IPC_CHANNELS.RECORDING_MIC_STATUS,
      (payload: unknown) => {
        const p = payload as { state: 'ended' | 'muted' | 'reacquired' }
        if (p.state === 'reacquired') setMicState('ok')
        else if (p.state === 'muted') setMicState('muted')
        else setMicState('ended')
      }
    )
    return () => {
      unsubFlow()
      unsubMic()
    }
  }, [isRecording])

  const handleTranscriptScroll = useCallback(() => {
    const el = transcriptScrollRef.current
    if (!el) return
    stuckToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }, [])

  // Auto-scroll transcript only when user is already at the bottom
  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el || !stuckToBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [liveTranscript, interimSegment])

  const handleStart = useCallback(async () => {
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(IPC_CHANNELS.RECORDING_START)
      startRecording(result.meetingId, result.meetingPlatform)
    } catch (err) {
      setError(String(err))
    }
  }, [startRecording, setError])

  const handleStop = useCallback(async () => {
    try {
      audioCapture.stop()
      await api.invoke(IPC_CHANNELS.RECORDING_STOP)
      stopRecording()
    } catch (err) {
      setError(String(err))
    }
  }, [stopRecording, setError, audioCapture])

  const handlePause = useCallback(async () => {
    try {
      audioCapture.pause()
      await api.invoke(IPC_CHANNELS.RECORDING_PAUSE)
      pauseRecording()
    } catch (err) {
      setError(String(err))
    }
  }, [pauseRecording, setError, audioCapture])

  const handleResume = useCallback(async () => {
    try {
      audioCapture.resume()
      await api.invoke(IPC_CHANNELS.RECORDING_RESUME)
      resumeRecording()
    } catch (err) {
      setError(String(err))
    }
  }, [resumeRecording, setError, audioCapture])

  const allSegments = [...liveTranscript, ...(interimSegment ? [interimSegment] : [])]

  return (
    <div className={styles.container}>
      <div className={styles.controls}>
        {!isRecording ? (
          <button className={styles.startBtn} onClick={handleStart}>
            Start Recording
          </button>
        ) : (
          <>
            <button className={styles.stopBtn} onClick={handleStop}>
              Stop Recording
            </button>
            {isPaused ? (
              <button className={styles.resumeBtn} onClick={handleResume}>
                Resume
              </button>
            ) : (
              <button className={styles.pauseBtn} onClick={handlePause}>
                Pause
              </button>
            )}
          </>
        )}
        {isRecording && (
          <div className={styles.status}>
            <span className={`${styles.recordingDot} ${isPaused ? styles.paused : ''}`} />
            <span className={styles.timer}>
              {formatTime(duration)}
              {isPaused && <span className={styles.pausedLabel}> (Paused)</span>}
            </span>
            <span className={styles.speakers}>
              {speakerCount} speaker{speakerCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {isRecording && hasSystemAudio === false && (
        <div className={styles.warning}>
          Mic only — system audio capture is not available. Grant Screen Recording
          permission in System Settings &gt; Privacy &amp; Security to capture meeting audio.
        </div>
      )}

      {isRecording && audioFlow?.state === 'stalled' && (
        <div className={styles.warning}>
          No audio received for {Math.floor(audioFlow.stalledForMs / 1000)}s. Another app may have
          taken your microphone or screen-audio capture. Check that Cyggie's window is in the
          foreground, then stop &amp; restart the recording if it doesn't recover.
        </div>
      )}

      {isRecording && micState === 'ended' && (
        <div className={styles.warning}>
          Microphone disconnected — attempting to reconnect. If it doesn't recover, stop the
          recording to save what was captured so far.
        </div>
      )}

      {isRecording && micState === 'muted' && (
        <div className={styles.warning}>
          Microphone is muted at the OS level. Unmute to continue capturing audio.
        </div>
      )}

      <div
        ref={transcriptScrollRef}
        className={styles.transcript}
        onScroll={handleTranscriptScroll}
      >
        {allSegments.length === 0 && !isRecording && (
          <p className={styles.placeholder}>
            Click "Start Recording" to begin transcribing a meeting.
          </p>
        )}
        {allSegments.length === 0 && isRecording && (
          <p className={styles.placeholder}>Waiting for speech...</p>
        )}
        {allSegments.map((segment, i) => (
          <div
            key={i}
            className={`${styles.segment} ${!segment.isFinal ? styles.interim : ''}`}
          >
            <span className={styles.speaker}>Speaker {segment.speaker + 1}</span>
            <span className={styles.text}>{segment.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
