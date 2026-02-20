import { useRef, useCallback, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'

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
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [isVideoRecording, setIsVideoRecording] = useState(false)
  const [videoError, setVideoError] = useState<string | null>(null)
  const meetingIdRef = useRef<string | null>(null)
  const ownStreamRef = useRef<MediaStream | null>(null)
  const borrowedVideoTrackRef = useRef<MediaStreamTrack | null>(null)

  const getFallbackStream = async (
    displayStream: MediaStream | null,
    mixedAudioStream: MediaStream | null
  ): Promise<MediaStream> => {
    if (displayStream) {
      const videoTracks = displayStream.getVideoTracks()
      if (videoTracks.length > 0 && videoTracks[0].readyState !== 'ended') {
        console.log('[VideoCapture] Reusing existing display stream video track')
        videoTracks[0].enabled = true
        borrowedVideoTrackRef.current = videoTracks[0]
        const audioTracks = mixedAudioStream?.getAudioTracks() || []
        return new MediaStream([...videoTracks, ...audioTracks])
      }
    }
    console.log('[VideoCapture] Requesting new display stream via loopback')
    await window.api.invoke('enable-loopback-audio')
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: true
      })
      ownStreamRef.current = stream
      return stream
    } finally {
      await window.api.invoke('disable-loopback-audio')
    }
  }

  const queueChunk = useCallback((meetingId: string, chunk: Blob): Promise<void> => {
    chunkQueueRef.current = chunkQueueRef.current
      .catch(() => {
        // Keep queue alive after a failed chunk write.
      })
      .then(async () => {
        const buffer = await chunk.arrayBuffer()
        await window.api.invoke(IPC_CHANNELS.VIDEO_CHUNK, meetingId, buffer)
      })

    return chunkQueueRef.current
  }, [])

  const start = useCallback(async (
    meetingId: string,
    displayStream: MediaStream | null,
    mixedAudioStream: MediaStream | null,
    meetingPlatform?: string | null
  ) => {
    try {
      setVideoError(null)
      meetingIdRef.current = meetingId

      let stream: MediaStream

      // When we know the meeting platform, try to capture just that app's window
      if (meetingPlatform && meetingPlatform !== 'other') {
        let captured = false
        try {
          const windowInfo = await window.api.invoke<{ sourceId: string; name: string } | null>(
            IPC_CHANNELS.VIDEO_FIND_WINDOW,
            meetingPlatform
          )
          if (windowInfo) {
            console.log(`[VideoCapture] Found ${meetingPlatform} window: "${windowInfo.name}"`)
            await window.api.invoke(IPC_CHANNELS.VIDEO_SET_WINDOW_SOURCE, windowInfo.sourceId)
            try {
              const windowStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 15, max: 30 } },
                audio: false
              })
              // Combine the window's video with the mixed audio from the audio capture
              const videoTracks = windowStream.getVideoTracks()
              const audioTracks = mixedAudioStream?.getAudioTracks() || []
              stream = new MediaStream([...videoTracks, ...audioTracks])
              ownStreamRef.current = windowStream
              captured = true
            } finally {
              await window.api.invoke(IPC_CHANNELS.VIDEO_CLEAR_WINDOW_SOURCE)
            }
          }
        } catch (err) {
          console.warn('[VideoCapture] Targeted window capture failed, falling back:', err)
        }

        if (!captured) {
          // Fall through to existing behavior
          stream = await getFallbackStream(displayStream, mixedAudioStream)
        }
      } else {
        stream = await getFallbackStream(displayStream, mixedAudioStream)
      }

      // Tell main process to prepare the file
      await window.api.invoke(IPC_CHANNELS.VIDEO_START, meetingId)

      const mimeType = getSupportedMimeType()
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 2_500_000
      })

      recorder.ondataavailable = (event) => {
        const activeMeetingId = meetingIdRef.current
        if (!activeMeetingId || event.data.size === 0) return

        queueChunk(activeMeetingId, event.data).catch((err) => {
          console.error('[VideoCapture] Failed to send video chunk:', err)
          setVideoError(String(err))
        })
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

      // Emit chunks frequently for smoother streaming into FFmpeg.
      recorder.start(1000)
      recorderRef.current = recorder
      setIsVideoRecording(true)
    } catch (err) {
      console.error('[VideoCapture] Failed to start:', err)
      setVideoError(String(err))
    }
  }, [queueChunk])

  const stop = useCallback(async () => {
    const recorder = recorderRef.current
    const meetingId = meetingIdRef.current
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.stop()
      })
    }

    try {
      await chunkQueueRef.current
      if (meetingId) {
        await window.api.invoke(IPC_CHANNELS.VIDEO_STOP, meetingId)
      }
    } catch (err) {
      console.error('[VideoCapture] Failed to finalize:', err)
      setVideoError(String(err))
    }

    // Clean up our own stream if we created one (don't stop the shared audio stream)
    if (ownStreamRef.current) {
      ownStreamRef.current.getVideoTracks().forEach((t) => t.stop())
      ownStreamRef.current = null
    }

    // Re-disable the borrowed video track so it doesn't interfere with the audio session
    if (borrowedVideoTrackRef.current) {
      borrowedVideoTrackRef.current.enabled = false
      borrowedVideoTrackRef.current = null
    }

    recorderRef.current = null
    meetingIdRef.current = null
    chunkQueueRef.current = Promise.resolve()
    setIsVideoRecording(false)
  }, [])

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
