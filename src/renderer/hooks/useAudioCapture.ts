import { useRef, useCallback, useState } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'

const TARGET_SAMPLE_RATE = 16000
const AUDIO_WORKLET_NAME = 'gorp-pcm-resample-processor'
// Loudness samples emitted every ~100 ms.
const LOUDNESS_WINDOW_MS = 100
// NLMS tuning — keep in sync with src/renderer/audio/nlms.ts which the
// worklet JS port below mirrors.
const NLMS_TAPS = 1024
const NLMS_MU = 0.08
const NLMS_CLIP_THRESHOLD = 4.0
const NLMS_DIVERGENCE_CLIP_BUDGET = 32

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
  // The worklet JS body is a self-contained string — AudioWorklets run
  // in an isolated global with no module imports. The NLMS + loudness
  // algorithms below MUST stay byte-equivalent to the typed reference
  // implementations in:
  //   - src/renderer/audio/nlms.ts (unit-tested)
  //   - src/renderer/audio/loudness-tap.ts (unit-tested)
  // Any change here that diverges from those modules is a bug; review
  // both files together. Drift risk is mitigated by keeping the algos
  // tiny and side-effect-free.
  return `
function createNlmsFilter(taps, mu, clipThreshold, clipBudget, sampleRate) {
  const w = new Float32Array(taps)
  const ref = new Float32Array(taps)
  let refHead = 0
  let state = 'adapting'
  const divWindow = Math.max(sampleRate, 1000)
  let clipsInWindow = 0
  const clipDecayPerSample = 1 / divWindow

  function process(micSample, refSample) {
    ref[refHead] = refSample
    refHead = (refHead + 1) % taps
    if (state === 'diverged') return micSample

    let yHat = 0
    let normSq = 0
    let idx = refHead
    for (let i = 0; i < taps; i++) {
      idx = idx === 0 ? taps - 1 : idx - 1
      const r = ref[idx]
      yHat += w[i] * r
      normSq += r * r
    }
    const error = micSample - yHat
    const muOverNorm = (mu * error) / (normSq + 1e-6)
    let maxCoef = 0
    idx = refHead
    for (let i = 0; i < taps; i++) {
      idx = idx === 0 ? taps - 1 : idx - 1
      w[i] += muOverNorm * ref[idx]
      const a = w[i] < 0 ? -w[i] : w[i]
      if (a > maxCoef) maxCoef = a
    }

    clipsInWindow = Math.max(0, clipsInWindow - clipDecayPerSample)
    if (maxCoef >= clipThreshold) clipsInWindow += 1
    if (clipsInWindow >= clipBudget) {
      state = 'diverged'
      return micSample
    }
    return error
  }

  function reset() {
    w.fill(0)
    ref.fill(0)
    refHead = 0
    clipsInWindow = 0
    state = 'adapting'
  }
  function isDiverged() { return state === 'diverged' }
  return { process, reset, isDiverged }
}

class GorpPcmResampleProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options && options.processorOptions ? options.processorOptions : {}
    this.targetSampleRate = opts.targetSampleRate || 16000
    this.useAec = opts.useAec === true
    this.ratio = sampleRate / this.targetSampleRate
    this.nextInputIndex = 0
    this.prevMic = 0
    this.prevSys = 0
    // NLMS filter operates on the native-rate mic channel BEFORE
    // resampling. Sized to the worklet's actual input sample rate.
    this.nlms = this.useAec
      ? createNlmsFilter(${NLMS_TAPS}, ${NLMS_MU}, ${NLMS_CLIP_THRESHOLD}, ${NLMS_DIVERGENCE_CLIP_BUDGET}, sampleRate)
      : null
    this.aecDegradedEmitted = false

    // Loudness accumulator. The renderer flushes via timer ticks; the
    // worklet just appends sum-of-squares + counts per channel.
    this.lWindowSamples = Math.max(1, Math.floor(sampleRate * (${LOUDNESS_WINDOW_MS} / 1000)))
    this.lMicSumSq = 0
    this.lSysSumSq = 0
    this.lMicCount = 0
    this.lSysCount = 0
    this.lWindowStartFrame = 0
    this.currentFrame = 0

    this.port.onmessage = (e) => {
      const data = e && e.data
      if (!data || typeof data !== 'object') return
      if (data.type === 'reset-aec' && this.nlms) {
        this.nlms.reset()
        this.aecDegradedEmitted = false
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      if (outputs[0]) for (let i = 0; i < outputs[0].length; i++) outputs[0][i].fill(0)
      return true
    }

    const mic = input[0]
    const sysIn = input.length > 1 ? input[1] : null
    const frameCount = mic.length
    // Working copy of the mic channel — NLMS writes the cleaned signal
    // here so resampling sees the post-AEC values.
    let micWork = mic
    if (this.useAec && this.nlms && sysIn) {
      const cleaned = new Float32Array(frameCount)
      for (let i = 0; i < frameCount; i++) {
        cleaned[i] = this.nlms.process(mic[i], sysIn[i])
      }
      micWork = cleaned
      if (!this.aecDegradedEmitted && this.nlms.isDiverged()) {
        this.aecDegradedEmitted = true
        this.port.postMessage({ type: 'aec-degraded' })
      }
    }

    // Loudness accounting at native sample rate. micWork captures any
    // AEC effect; sysIn is the raw reference.
    let micSumSq = 0
    for (let i = 0; i < frameCount; i++) micSumSq += micWork[i] * micWork[i]
    this.lMicSumSq += micSumSq
    this.lMicCount += frameCount
    if (sysIn) {
      let sysSumSq = 0
      for (let i = 0; i < frameCount; i++) sysSumSq += sysIn[i] * sysIn[i]
      this.lSysSumSq += sysSumSq
      this.lSysCount += frameCount
    }
    this.currentFrame += frameCount
    if (this.currentFrame - this.lWindowStartFrame >= this.lWindowSamples) {
      const micDb = this.lMicCount > 0 && this.lMicSumSq > 0
        ? 20 * Math.log10(Math.sqrt(this.lMicSumSq / this.lMicCount))
        : -Infinity
      const sysDb = this.lSysCount > 0 && this.lSysSumSq > 0
        ? 20 * Math.log10(Math.sqrt(this.lSysSumSq / this.lSysCount))
        : -Infinity
      this.port.postMessage({
        type: 'loudness-sample',
        tStart: this.lWindowStartFrame / sampleRate,
        tEnd: this.currentFrame / sampleRate,
        micDb,
        sysDb,
      })
      this.lMicSumSq = 0
      this.lSysSumSq = 0
      this.lMicCount = 0
      this.lSysCount = 0
      this.lWindowStartFrame = this.currentFrame
    }

    // Existing resample + interleave path.
    const interleaved = []
    while (this.nextInputIndex < frameCount) {
      const srcIndex = this.nextInputIndex
      const base = Math.floor(srcIndex)
      const frac = srcIndex - base
      const next = Math.min(base + 1, frameCount - 1)

      const micA = base >= 0 ? micWork[base] : this.prevMic
      const micB = next >= 0 ? micWork[next] : this.prevMic
      const micSample = micA + (micB - micA) * frac

      let sysSample = 0
      if (sysIn) {
        const sysA = base >= 0 ? sysIn[base] : this.prevSys
        const sysB = next >= 0 ? sysIn[next] : this.prevSys
        sysSample = sysA + (sysB - sysA) * frac
      }

      const clampMic = Math.max(-1, Math.min(1, micSample))
      const clampSys = Math.max(-1, Math.min(1, sysSample))
      interleaved.push(
        clampMic < 0 ? Math.round(clampMic * 0x8000) : Math.round(clampMic * 0x7fff),
        clampSys < 0 ? Math.round(clampSys * 0x8000) : Math.round(clampSys * 0x7fff),
      )
      this.nextInputIndex += this.ratio
    }
    this.nextInputIndex -= frameCount
    this.prevMic = micWork[frameCount - 1]
    this.prevSys = sysIn ? sysIn[frameCount - 1] : 0

    if (interleaved.length > 0) {
      const out = new Int16Array(interleaved)
      this.port.postMessage({ type: 'pcm', buffer: out.buffer }, [out.buffer])
    }

    if (outputs[0]) for (let i = 0; i < outputs[0].length; i++) outputs[0][i].fill(0)
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
 *
 * `start(opts)` accepts a `useAec` flag (when true, the worklet runs an
 * NLMS adaptive echo canceller on the mic using the system loopback as
 * reference) and a `channels` count that influences nothing in this
 * hook directly — channel resolution is the caller's responsibility
 * (RecordingSession passes it through resolveStreamConfig).
 */
export interface AudioCaptureStartOptions {
  useAec?: boolean
}

export function useAudioCapture() {
  const micStreamRef = useRef<MediaStream | null>(null)
  const systemStreamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null)
  const processorSinkRef = useRef<GainNode | null>(null)
  const pausedRef = useRef(false)
  const mixedStreamRef = useRef<MediaStream | null>(null)
  const currentMicConstraintsRef = useRef<MediaTrackConstraints>(PROCESSED_MIC_CONSTRAINTS)
  const visibilityHandlerRef = useRef<(() => void) | null>(null)
  const micReacquireInFlightRef = useRef(false)
  const [hasSystemAudio, setHasSystemAudio] = useState<boolean | null>(null)

  const start = useCallback(async (opts: AudioCaptureStartOptions = {}) => {
    const useAec = opts.useAec === true
    setHasSystemAudio(null)
    currentMicConstraintsRef.current = PROCESSED_MIC_CONSTRAINTS
    micReacquireInFlightRef.current = false

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

    // Auto-resume + AEC reset on suspend/resume cycles (e.g. headphone
    // plug/unplug). When the context flips state we postMessage the
    // worklet so the adaptive filter zeros its coefficients — the
    // acoustic path almost certainly changed.
    context.onstatechange = () => {
      if (context.state === 'suspended') {
        context.resume().catch(() => {})
      } else if (context.state === 'running' && processorRef.current && 'port' in processorRef.current) {
        try {
          ;(processorRef.current as AudioWorkletNode).port.postMessage({ type: 'reset-aec' })
        } catch {
          // Worklet may have torn down; ignore.
        }
      }
    }

    let micSource = context.createMediaStreamSource(micStream)
    let micGain = context.createGain()

    // Merge node: mix mic + optional system audio into a single output
    const merger = context.createChannelMerger(2)
    micGain.gain.value = 1.0
    micSource.connect(micGain)
    micGain.connect(merger, 0, 0)

    const swapMicStream = (newStream: MediaStream): void => {
      const previousMic = micStreamRef.current
      micSource.disconnect()
      micGain.disconnect()
      micSource = context.createMediaStreamSource(newStream)
      micGain = context.createGain()
      micGain.gain.value = 1.0
      micSource.connect(micGain)
      micGain.connect(merger, 0, 0)
      micStreamRef.current = newStream
      previousMic?.getTracks().forEach((t) => t.stop())
      attachMicLifecycle(newStream)
    }

    let rawMicModeEnabled = false
    const switchToRawMicMode = async (reason: string): Promise<void> => {
      if (rawMicModeEnabled) return
      rawMicModeEnabled = true
      try {
        const rawMicStream = await captureMic(RAW_MIC_CONSTRAINTS)
        currentMicConstraintsRef.current = RAW_MIC_CONSTRAINTS
        swapMicStream(rawMicStream)
        console.log(`[AudioCapture] Switched to raw mic mode (${reason})`)
      } catch (err) {
        console.warn('[AudioCapture] Failed to switch to raw mic mode:', err)
      }
    }

    const reacquireMic = async (reason: string): Promise<void> => {
      if (micReacquireInFlightRef.current) return
      micReacquireInFlightRef.current = true
      try {
        const newStream = await captureMic(currentMicConstraintsRef.current)
        swapMicStream(newStream)
        api.send('recording:mic-status', { state: 'reacquired', reason })
        console.log(`[AudioCapture] Mic re-acquired (${reason})`)
      } catch (err) {
        api.send('recording:mic-status', {
          state: 'ended',
          reason: `${reason} + reacquire-failed`
        })
        console.error('[AudioCapture] Mic re-acquire failed:', err)
      } finally {
        micReacquireInFlightRef.current = false
      }
    }

    function attachMicLifecycle(stream: MediaStream): void {
      const track = stream.getAudioTracks()[0]
      if (!track) return
      track.onended = () => {
        console.warn('[AudioCapture] Mic track ended')
        api.send('recording:mic-status', { state: 'ended', reason: 'track-onended' })
        void reacquireMic('track-onended')
      }
      track.onmute = () => {
        console.warn('[AudioCapture] Mic track muted')
        api.send('recording:mic-status', { state: 'muted', reason: 'track-onmute' })
      }
      track.onunmute = () => {
        console.log('[AudioCapture] Mic track unmuted')
        api.send('recording:mic-status', { state: 'reacquired', reason: 'track-onunmute' })
      }
    }

    attachMicLifecycle(micStream)

    // Keep AudioContext alive across window focus changes. Chromium can suspend
    // an AudioContext when the page is hidden; the existing onstatechange
    // handler covers the suspended event, but a visibilitychange listener
    // gives us a second chance the moment the user comes back to the window.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && context.state === 'suspended') {
        console.log('[AudioCapture] Resuming AudioContext on visibility change')
        context.resume().catch((err) => {
          console.warn('[AudioCapture] AudioContext.resume() failed:', err)
        })
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    visibilityHandlerRef.current = onVisibility

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
          processorOptions: { targetSampleRate: TARGET_SAMPLE_RATE, useAec },
        })

        workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
          // The worklet now sends typed messages. Legacy raw-ArrayBuffer
          // payloads are preserved for the ScriptProcessor fallback path
          // only — every worklet message arrives as {type, ...}.
          const data = event.data
          if (data instanceof ArrayBuffer) {
            if (!pausedRef.current) api.send(IPC_CHANNELS.RECORDING_AUDIO_DATA, data)
            return
          }
          if (!data || typeof data !== 'object' || !('type' in data)) return
          const msg = data as { type: string; [k: string]: unknown }
          if (msg.type === 'pcm') {
            if (!pausedRef.current && msg.buffer instanceof ArrayBuffer) {
              api.send(IPC_CHANNELS.RECORDING_AUDIO_DATA, msg.buffer)
            }
          } else if (msg.type === 'aec-degraded') {
            console.warn('[AudioCapture] NLMS diverged; AEC switching to passthrough for rest of session')
            api.send(IPC_CHANNELS.RECORDING_AEC_DEGRADED)
          } else if (msg.type === 'loudness-sample') {
            if (!pausedRef.current) {
              api.send(IPC_CHANNELS.RECORDING_LOUDNESS_SAMPLE, {
                tStart: msg.tStart,
                tEnd: msg.tEnd,
                micDb: msg.micDb,
                sysDb: msg.sysDb,
              })
            }
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
      // Fallback: ScriptProcessorNode path. Skips NLMS + loudness tap
      // entirely — they're worklet-only by design. Multichannel + me/them
      // resolver downgrades to most-talkative in this branch.
      const ratio = context.sampleRate / TARGET_SAMPLE_RATE
      const processor = context.createScriptProcessor(4096, 2, 1)
      processor.onaudioprocess = (event) => {
        if (pausedRef.current) return
        const ch0 = event.inputBuffer.getChannelData(0)
        const ch1 = event.inputBuffer.numberOfChannels > 1
          ? event.inputBuffer.getChannelData(1)
          : null
        const pcmBuffer = downsampleInterleaved(ch0, ch1, ratio)
        api.send(IPC_CHANNELS.RECORDING_AUDIO_DATA, pcmBuffer)
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
    if (visibilityHandlerRef.current) {
      document.removeEventListener('visibilitychange', visibilityHandlerRef.current)
      visibilityHandlerRef.current = null
    }
    micReacquireInFlightRef.current = false
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
      micStreamRef.current.getTracks().forEach((t) => {
        t.onended = null
        t.onmute = null
        t.onunmute = null
        t.stop()
      })
      micStreamRef.current = null
    }
    if (systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => {
        t.onended = null
        t.onmute = null
        t.onunmute = null
        t.stop()
      })
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
