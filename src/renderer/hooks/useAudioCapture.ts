import { useRef, useCallback, useState } from 'react'
import { api } from '../api'

const TARGET_SAMPLE_RATE = 16000
const AUDIO_WORKLET_NAME = 'gorp-pcm-resample-processor'
const PROCESSED_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}
const RAW_MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
}

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample))
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
}

function downsampleInterleaved(
  micChannel: Float32Array,
  sysChannel: Float32Array | null,
  ratio: number
): ArrayBuffer {
  const outputLen = Math.max(0, Math.floor(micChannel.length / ratio))
  const int16Data = new Int16Array(outputLen * 2)

  for (let i = 0; i < outputLen; i++) {
    const srcIdx = i * ratio
    const srcFloor = Math.floor(srcIdx)
    const frac = srcIdx - srcFloor
    const next = Math.min(srcFloor + 1, micChannel.length - 1)

    const mic = micChannel[srcFloor] + (micChannel[next] - micChannel[srcFloor]) * frac
    int16Data[i * 2] = floatToInt16(mic)

    if (sysChannel) {
      const sys = sysChannel[srcFloor] + (sysChannel[next] - sysChannel[srcFloor]) * frac
      int16Data[i * 2 + 1] = floatToInt16(sys)
    } else {
      int16Data[i * 2 + 1] = 0
    }
  }

  return int16Data.buffer
}

function buildWorkletModuleSource(): string {
  return `
class GorpPcmResampleProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options && options.processorOptions ? options.processorOptions : {}
    this.targetSampleRate = opts.targetSampleRate || 16000
    this.ratio = sampleRate / this.targetSampleRate
    this.nextInputIndex = 0
    this.prevMic = 0
    this.prevSys = 0
  }

  toInt16(sample) {
    const clamped = Math.max(-1, Math.min(1, sample))
    return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }

  process(inputs, outputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      if (outputs[0]) {
        for (let i = 0; i < outputs[0].length; i++) outputs[0][i].fill(0)
      }
      return true
    }

    const mic = input[0]
    const sys = input.length > 1 ? input[1] : null
    const frameCount = mic.length
    const interleaved = []

    while (this.nextInputIndex < frameCount) {
      const srcIndex = this.nextInputIndex
      const base = Math.floor(srcIndex)
      const frac = srcIndex - base
      const next = Math.min(base + 1, frameCount - 1)

      const micA = base >= 0 ? mic[base] : this.prevMic
      const micB = next >= 0 ? mic[next] : this.prevMic
      const micSample = micA + (micB - micA) * frac

      let sysSample = 0
      if (sys) {
        const sysA = base >= 0 ? sys[base] : this.prevSys
        const sysB = next >= 0 ? sys[next] : this.prevSys
        sysSample = sysA + (sysB - sysA) * frac
      }

      interleaved.push(this.toInt16(micSample), this.toInt16(sysSample))
      this.nextInputIndex += this.ratio
    }

    this.nextInputIndex -= frameCount
    this.prevMic = mic[frameCount - 1]
    this.prevSys = sys ? sys[frameCount - 1] : 0

    if (interleaved.length > 0) {
      const out = new Int16Array(interleaved)
      this.port.postMessage(out.buffer, [out.buffer])
    }

    if (outputs[0]) {
      for (let i = 0; i < outputs[0].length; i++) outputs[0][i].fill(0)
    }
    return true
  }
}

registerProcessor('${AUDIO_WORKLET_NAME}', GorpPcmResampleProcessor)
`
}

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
  const processorRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null)
  const processorSinkRef = useRef<GainNode | null>(null)
  const pausedRef = useRef(false)
  const mixedStreamRef = useRef<MediaStream | null>(null)
  const [hasSystemAudio, setHasSystemAudio] = useState<boolean | null>(null)

  const start = useCallback(async () => {
    setHasSystemAudio(null)

    const captureMic = async (constraints: MediaTrackConstraints): Promise<MediaStream> => {
      return navigator.mediaDevices.getUserMedia({ audio: constraints })
    }

    // Start with speech-enhanced mic settings; if system audio is unavailable, we
    // switch to raw mic settings so far-end speech from speakers is less likely to be suppressed.
    const micStream = await captureMic(PROCESSED_MIC_CONSTRAINTS)
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

    let micSource = context.createMediaStreamSource(micStream)
    let micGain = context.createGain()

    // Merge node: mix mic + optional system audio into a single output
    const merger = context.createChannelMerger(2)
    micGain.gain.value = 1.0
    micSource.connect(micGain)
    micGain.connect(merger, 0, 0)

    let rawMicModeEnabled = false
    const switchToRawMicMode = async (reason: string): Promise<void> => {
      if (rawMicModeEnabled) return
      rawMicModeEnabled = true
      try {
        const rawMicStream = await captureMic(RAW_MIC_CONSTRAINTS)
        const previousMic = micStreamRef.current

        micSource.disconnect()
        micGain.disconnect()

        micSource = context.createMediaStreamSource(rawMicStream)
        micGain = context.createGain()
        micGain.gain.value = 1.0
        micSource.connect(micGain)
        micGain.connect(merger, 0, 0)

        micStreamRef.current = rawMicStream
        previousMic?.getTracks().forEach((t) => t.stop())
        console.log(`[AudioCapture] Switched to raw mic mode (${reason})`)
      } catch (err) {
        console.warn('[AudioCapture] Failed to switch to raw mic mode:', err)
      }
    }

    const markSystemAudioUnavailable = async (reason: string): Promise<void> => {
      console.warn(`[AudioCapture] System audio unavailable (${reason}); using mic-only fallback`)
      setHasSystemAudio(false)
      api.send('recording:system-audio-status', false)
      await switchToRawMicMode(reason)
    }

    // Try to capture system audio (loopback) using electron-audio-loopback's
    // IPC flow: enable the handler, call getDisplayMedia, then disable it.
    let systemSource: MediaStreamAudioSourceNode | null = null
    try {
      // Tell the main process to set up the loopback display media handler
      await api.invoke('enable-loopback-audio')

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      })

      // Restore normal getDisplayMedia behaviour
      await api.invoke('disable-loopback-audio')

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
          await markSystemAudioUnavailable('loopback-track-ended-on-start')
        } else {
          systemStreamRef.current = displayStream
          systemSource = context.createMediaStreamSource(displayStream)
          const systemGain = context.createGain()
          systemGain.gain.value = 1.0
          systemSource.connect(systemGain)
          systemGain.connect(merger, 0, 1)
          setHasSystemAudio(true)
          api.send('recording:system-audio-status', true)

          // Detect if the audio track is killed mid-recording (e.g. by video capture stopping shared streams)
          track.onended = () => {
            console.error('[AudioCapture] System audio track ended unexpectedly during recording')
            setHasSystemAudio(false)
            api.send('recording:system-audio-status', false)
            void switchToRawMicMode('loopback-track-ended-mid-recording')
          }

          console.log(
            '[AudioCapture] System audio loopback active',
            `(context ${context.sampleRate} Hz, track ${track.getSettings().sampleRate ?? 'unknown'} Hz)`
          )
        }
      } else {
        await markSystemAudioUnavailable('no-loopback-audio-tracks')
      }
    } catch (err) {
      await markSystemAudioUnavailable('loopback-capture-error')
      console.warn('[AudioCapture] Loopback capture error details:', err)
      // Make sure we disable the handler even on error
      try {
        await api.invoke('disable-loopback-audio')
      } catch {
        // ignore
      }
    }

    // If no system audio, mic alone through the merger still works (channel 1 stays silent)

    // Tap merged audio at native sample rate for video recording (mic + system mixed)
    const destination = context.createMediaStreamDestination()
    merger.connect(destination)
    mixedStreamRef.current = destination.stream

    const attachSilentSink = (node: AudioNode) => {
      const sink = context.createGain()
      sink.gain.value = 0
      node.connect(sink)
      sink.connect(context.destination)
      processorSinkRef.current = sink
    }

    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const moduleBlob = new Blob([buildWorkletModuleSource()], {
          type: 'application/javascript'
        })
        const moduleUrl = URL.createObjectURL(moduleBlob)
        try {
          await context.audioWorklet.addModule(moduleUrl)
        } finally {
          URL.revokeObjectURL(moduleUrl)
        }

        const workletNode = new AudioWorkletNode(context, AUDIO_WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE }
        })

        workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
          if (pausedRef.current) return
          if (event.data instanceof ArrayBuffer) {
            api.send('recording:audio-data', event.data)
          }
        }

        processorRef.current = workletNode
        merger.connect(workletNode)
        attachSilentSink(workletNode)
      } catch (err) {
        console.warn('[AudioCapture] AudioWorklet unavailable; falling back to ScriptProcessorNode:', err)
      }
    }

    if (!processorRef.current) {
      const ratio = context.sampleRate / TARGET_SAMPLE_RATE
      const processor = context.createScriptProcessor(4096, 2, 1)
      processor.onaudioprocess = (event) => {
        if (pausedRef.current) return
        const ch0 = event.inputBuffer.getChannelData(0)
        const ch1 = event.inputBuffer.numberOfChannels > 1
          ? event.inputBuffer.getChannelData(1)
          : null
        const pcmBuffer = downsampleInterleaved(ch0, ch1, ratio)
        api.send('recording:audio-data', pcmBuffer)
      }

      processorRef.current = processor
      merger.connect(processor)
      attachSilentSink(processor)
    }
  }, [])

  const stop = useCallback(() => {
    pausedRef.current = false
    setHasSystemAudio(null)
    mixedStreamRef.current = null
    if (processorRef.current) {
      if ('onaudioprocess' in processorRef.current) {
        ;(processorRef.current as ScriptProcessorNode).onaudioprocess = null
      }
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (processorSinkRef.current) {
      processorSinkRef.current.disconnect()
      processorSinkRef.current = null
    }
    if (contextRef.current) {
      contextRef.current.close().catch(() => {
        // ignore close errors during teardown
      })
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
