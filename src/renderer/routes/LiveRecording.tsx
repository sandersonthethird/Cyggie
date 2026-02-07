import { useCallback, useEffect, useRef } from 'react'
import { useRecordingStore } from '../stores/recording.store'
import { useSharedAudioCapture } from '../contexts/AudioCaptureContext'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import styles from './LiveRecording.module.css'

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
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveTranscript, interimSegment])

  const handleStart = useCallback(async () => {
    try {
      const result = await window.api.invoke<{ meetingId: string }>(IPC_CHANNELS.RECORDING_START)
      startRecording(result.meetingId)
    } catch (err) {
      setError(String(err))
    }
  }, [startRecording, setError])

  const handleStop = useCallback(async () => {
    try {
      audioCapture.stop()
      await window.api.invoke(IPC_CHANNELS.RECORDING_STOP)
      stopRecording()
    } catch (err) {
      setError(String(err))
    }
  }, [stopRecording, setError, audioCapture])

  const handlePause = useCallback(async () => {
    try {
      audioCapture.pause()
      await window.api.invoke(IPC_CHANNELS.RECORDING_PAUSE)
      pauseRecording()
    } catch (err) {
      setError(String(err))
    }
  }, [pauseRecording, setError, audioCapture])

  const handleResume = useCallback(async () => {
    try {
      audioCapture.resume()
      await window.api.invoke(IPC_CHANNELS.RECORDING_RESUME)
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

      {isRecording && !hasSystemAudio && (
        <div className={styles.warning}>
          Mic only — system audio capture is not available. Grant Screen Recording
          permission in System Settings &gt; Privacy &amp; Security to capture meeting audio.
        </div>
      )}

      <div className={styles.transcript}>
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
        <div ref={transcriptEndRef} />
      </div>
    </div>
  )
}
