import { useRef, useCallback, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'

const FLUSH_INTERVAL_MS = 30_000
const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm'
]

function getSupportedMimeType(): string {
  for (const mime of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  throw new Error('No supported video MIME type found')
}

export function useVideoCapture() {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [isVideoRecording, setIsVideoRecording] = useState(false)
  const [videoError, setVideoError] = useState<string | null>(null)
  const meetingIdRef = useRef<string | null>(null)
  const ownStreamRef = useRef<MediaStream | null>(null)

  const flushChunks = useCallback(() => {
    if (chunksRef.current.length === 0 || !meetingIdRef.current) return
    const blob = new Blob(chunksRef.current, { type: chunksRef.current[0].type })
    chunksRef.current = []
    blob.arrayBuffer().then((buffer) => {
      window.api.send(IPC_CHANNELS.VIDEO_CHUNK, meetingIdRef.current, buffer)
    })
  }, [])

  const start = useCallback(async (
    meetingId: string,
    displayStream: MediaStream | null,
    mixedAudioStream: MediaStream | null
  ) => {
    try {
      setVideoError(null)
      meetingIdRef.current = meetingId

      let stream: MediaStream

      if (displayStream) {
        // Reuse the existing display stream from audio capture
        const videoTracks = displayStream.getVideoTracks()
        if (videoTracks.length > 0 && videoTracks[0].readyState !== 'ended') {
          console.log('[VideoCapture] Reusing existing display stream video track')
          videoTracks[0].enabled = true
          const audioTracks = mixedAudioStream?.getAudioTracks() || []
          stream = new MediaStream([...videoTracks, ...audioTracks])
        } else {
          // Video track ended; request a new stream via loopback handler
          console.log('[VideoCapture] Video tracks ended/missing, requesting new display stream')
          await window.api.invoke('enable-loopback-audio')
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 15, max: 30 } },
              audio: true
            })
          } finally {
            await window.api.invoke('disable-loopback-audio')
          }
          ownStreamRef.current = stream
        }
      } else {
        // No existing display stream (mic-only mode); request via loopback handler
        console.log('[VideoCapture] No display stream, requesting new one')
        await window.api.invoke('enable-loopback-audio')
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 15, max: 30 } },
            audio: true
          })
        } finally {
          await window.api.invoke('disable-loopback-audio')
        }
        ownStreamRef.current = stream
      }

      // Tell main process to prepare the file
      await window.api.invoke(IPC_CHANNELS.VIDEO_START, meetingId)

      const mimeType = getSupportedMimeType()
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_500_000
      })

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        setVideoError('Video recording error')
      }

      // Listen for the video track ending (user stops sharing via OS controls)
      const videoTrack = stream.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.onended = () => {
          if (recorderRef.current && recorderRef.current.state !== 'inactive') {
            stop()
          }
        }
      }

      // Request data every 5 seconds for fine-grained flushing
      recorder.start(5000)
      recorderRef.current = recorder
      setIsVideoRecording(true)

      // Periodic flush to main process
      flushTimerRef.current = setInterval(flushChunks, FLUSH_INTERVAL_MS)
    } catch (err) {
      console.error('[VideoCapture] Failed to start:', err)
      setVideoError(String(err))
    }
  }, [flushChunks])

  const stop = useCallback(async () => {
    if (flushTimerRef.current) {
      clearInterval(flushTimerRef.current)
      flushTimerRef.current = null
    }

    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.ondataavailable = async (event) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data)
          }
          flushChunks()
          try {
            await window.api.invoke(IPC_CHANNELS.VIDEO_STOP, meetingIdRef.current)
          } catch (err) {
            console.error('[VideoCapture] Failed to finalize:', err)
          }
          resolve()
        }
        recorder.stop()
      })
    }

    // Clean up our own stream if we created one (don't stop the shared audio stream)
    if (ownStreamRef.current) {
      ownStreamRef.current.getTracks().forEach((t) => t.stop())
      ownStreamRef.current = null
    }

    recorderRef.current = null
    meetingIdRef.current = null
    chunksRef.current = []
    setIsVideoRecording(false)
  }, [flushChunks])

  const pause = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.pause()
    }
  }, [])

  const resume = useCallback(() => {
    if (recorderRef.current?.state === 'paused') {
      recorderRef.current.resume()
    }
  }, [])

  return { start, stop, pause, resume, isVideoRecording, videoError }
}
