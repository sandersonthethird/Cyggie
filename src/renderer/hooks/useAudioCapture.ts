import { useRef, useCallback, useState } from 'react'

/**
 * Captures microphone audio AND system audio (loopback) in the renderer process,
 * mixes them into a single stream, and sends PCM chunks to the main process
 * via IPC for Deepgram transcription.
 *
 * System audio capture uses electron-audio-loopback which leverages
 * CoreAudioTap on macOS 14.2+. Falls back to mic-only if system
 * audio is unavailable.
 */
export function useAudioCapture() {
  const micStreamRef = useRef<MediaStream | null>(null)
  const systemStreamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const pausedRef = useRef(false)
  const mixedStreamRef = useRef<MediaStream | null>(null)
  const [hasSystemAudio, setHasSystemAudio] = useState<boolean | null>(null)

  const start = useCallback(async () => {
    setHasSystemAudio(null)

    // Always capture mic
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    })
    micStreamRef.current = micStream

    // Use the system's native sample rate so that MediaStreamAudioSourceNode
    // from getDisplayMedia (which delivers audio at the system rate, typically
    // 48 kHz) does not need to resample. Forcing 16 kHz caused silence on
    // the loopback channel due to unreliable Chromium cross-rate resampling.
    const context = new AudioContext()
    contextRef.current = context

    // Auto-resume if the context suspends due to an output device change
    // (e.g. headphones plugged in / unplugged mid-recording)
    context.onstatechange = () => {
      if (context.state === 'suspended') {
        context.resume()
      }
    }

    const micSource = context.createMediaStreamSource(micStream)

    // Merge node: mix mic + optional system audio into a single output
    const merger = context.createChannelMerger(2)
    const micGain = context.createGain()
    micGain.gain.value = 1.0
    micSource.connect(micGain)
    micGain.connect(merger, 0, 0)

    // Try to capture system audio (loopback) using electron-audio-loopback's
    // IPC flow: enable the handler, call getDisplayMedia, then disable it.
    let systemSource: MediaStreamAudioSourceNode | null = null
    try {
      // Tell the main process to set up the loopback display media handler
      await window.api.invoke('enable-loopback-audio')

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })

      // Restore normal getDisplayMedia behaviour
      await window.api.invoke('disable-loopback-audio')

      // Log all track states before touching anything
      const videoTracks = displayStream.getVideoTracks()
      const audioTracks = displayStream.getAudioTracks()
      console.log(
        '[AudioCapture] getDisplayMedia returned:',
        `${videoTracks.length} video (${videoTracks.map((t) => t.readyState).join(', ')}),`,
        `${audioTracks.length} audio (${audioTracks.map((t) => t.readyState).join(', ')})`
      )

      // Disable video tracks — we only need audio, but calling stop()
      // terminates the underlying capture session on macOS 15+.
      videoTracks.forEach((t) => {
        t.enabled = false
      })

      if (audioTracks.length > 0) {
        const track = audioTracks[0]
        if (track.readyState === 'ended') {
          console.warn(
            '[AudioCapture] Loopback audio track arrived in ended state.',
            'Check macOS System Settings > Privacy & Security > Screen & System Audio Recording.',
            'Try toggling the Electron permission off and on, then restart the app.'
          )
          setHasSystemAudio(false)
          window.api.send('recording:system-audio-status', false)
        } else {
          systemStreamRef.current = displayStream
          systemSource = context.createMediaStreamSource(displayStream)
          const systemGain = context.createGain()
          systemGain.gain.value = 1.0
          systemSource.connect(systemGain)
          systemGain.connect(merger, 0, 1)
          setHasSystemAudio(true)
          window.api.send('recording:system-audio-status', true)
          console.log(
            '[AudioCapture] System audio loopback active',
            `(context ${context.sampleRate} Hz, track ${track.getSettings().sampleRate ?? 'unknown'} Hz)`
          )
        }
      } else {
        console.warn('[AudioCapture] getDisplayMedia returned no audio tracks')
        setHasSystemAudio(false)
        window.api.send('recording:system-audio-status', false)
      }
    } catch (err) {
      console.warn('[AudioCapture] System audio unavailable, using mic only:', err)
      setHasSystemAudio(false)
      window.api.send('recording:system-audio-status', false)
      // Make sure we disable the handler even on error
      try {
        await window.api.invoke('disable-loopback-audio')
      } catch {
        // ignore
      }
    }

    // If no system audio, mic alone through the merger still works (channel 1 stays silent)

    // Tap merged audio at native sample rate for video recording (mic + system mixed)
    const destination = context.createMediaStreamDestination()
    merger.connect(destination)
    mixedStreamRef.current = destination.stream

    // Compute resampling ratio: context.sampleRate → 16 kHz for Deepgram
    const targetRate = 16000
    const ratio = context.sampleRate / targetRate

    // Send 2-channel interleaved PCM (ch0=mic, ch1=system) for multichannel diarization
    const processor = context.createScriptProcessor(4096, 2, 1)
    processorRef.current = processor

    processor.onaudioprocess = (event) => {
      if (pausedRef.current) return
      const ch0 = event.inputBuffer.getChannelData(0) // mic
      const ch1 = event.inputBuffer.numberOfChannels > 1
        ? event.inputBuffer.getChannelData(1) // system audio
        : null

      // Downsample from context rate to 16 kHz via linear interpolation
      const outputLen = Math.floor(ch0.length / ratio)
      // 2-channel interleaved: [mic0, sys0, mic1, sys1, ...]
      const int16Data = new Int16Array(outputLen * 2)

      for (let i = 0; i < outputLen; i++) {
        const srcIdx = i * ratio
        const srcFloor = Math.floor(srcIdx)
        const frac = srcIdx - srcFloor
        const next = Math.min(srcFloor + 1, ch0.length - 1)

        // Channel 0 (mic) - interpolated
        const mic = ch0[srcFloor] + (ch0[next] - ch0[srcFloor]) * frac
        const micClamped = Math.max(-1, Math.min(1, mic))
        int16Data[i * 2] = micClamped < 0 ? micClamped * 0x8000 : micClamped * 0x7fff

        // Channel 1 (system audio) - interpolated, or silence if unavailable
        if (ch1) {
          const sys = ch1[srcFloor] + (ch1[next] - ch1[srcFloor]) * frac
          const sysClamped = Math.max(-1, Math.min(1, sys))
          int16Data[i * 2 + 1] = sysClamped < 0 ? sysClamped * 0x8000 : sysClamped * 0x7fff
        } else {
          int16Data[i * 2 + 1] = 0
        }
      }

      window.api.send('recording:audio-data', int16Data.buffer)
    }

    merger.connect(processor)
    processor.connect(context.destination)
  }, [])

  const stop = useCallback(() => {
    pausedRef.current = false
    setHasSystemAudio(null)
    mixedStreamRef.current = null
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (contextRef.current) {
      contextRef.current.close()
      contextRef.current = null
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
    }
    if (systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => t.stop())
      systemStreamRef.current = null
    }
  }, [])

  const pause = useCallback(() => {
    pausedRef.current = true
  }, [])

  const resume = useCallback(() => {
    pausedRef.current = false
  }, [])

  const getDisplayStream = useCallback(() => {
    return systemStreamRef.current
  }, [])

  const getMixedAudioStream = useCallback(() => {
    return mixedStreamRef.current
  }, [])

  return { start, stop, pause, resume, hasSystemAudio, getDisplayStream, getMixedAudioStream }
}
