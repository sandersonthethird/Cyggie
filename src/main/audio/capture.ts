import { EventEmitter } from 'events'
import { AudioStreamManager } from './stream-manager'

export type AudioCaptureSource = 'system' | 'microphone'

export type AudioFlowState = 'flowing' | 'stalled'

export interface AudioFlowStatus {
  state: AudioFlowState
  stalledForMs: number
}

const HEARTBEAT_INTERVAL_MS = 2000
const STALL_THRESHOLD_MS = 8000

/**
 * Audio capture orchestrator. Currently provides a microphone fallback
 * using Web Audio APIs via the renderer process.
 *
 * System audio capture (electron-audio-loopback / audiotee) can be
 * integrated once the base pipeline is working.
 */
export class AudioCapture extends EventEmitter {
  private streamManager: AudioStreamManager
  private isCapturing = false
  private isPaused = false
  private lastChunkAt = 0
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private flowState: AudioFlowState = 'flowing'

  constructor(channels: number = 2) {
    super()
    this.streamManager = new AudioStreamManager(16000, channels, 100)

    this.streamManager.on('chunk', (chunk: Buffer) => {
      this.emit('audio-chunk', chunk)
    })
  }

  start(): void {
    if (this.isCapturing) return
    console.log('[AudioCapture] Starting capture')
    this.isCapturing = true
    this.lastChunkAt = Date.now()
    this.flowState = 'flowing'
    this.streamManager.start()
    this.startHeartbeat()
    this.emit('started')
  }

  stop(): void {
    if (!this.isCapturing) return
    this.isCapturing = false
    this.isPaused = false
    this.stopHeartbeat()
    this.streamManager.stop()
    this.emit('stopped')
  }

  pause(): void {
    this.isPaused = true
    // Reset the silence clock so a long pause doesn't trip the stall heartbeat
    // the moment we resume.
    this.lastChunkAt = Date.now()
  }

  resume(): void {
    this.isPaused = false
    this.lastChunkAt = Date.now()
  }

  /**
   * Feed audio data from the renderer process (via IPC).
   * The renderer captures audio using getUserMedia or desktopCapturer
   * and sends PCM chunks to main via IPC.
   */
  feedAudioFromRenderer(pcmData: Buffer): void {
    if (!this.isCapturing || this.isPaused) {
      console.log('[AudioCapture] Ignoring audio - capturing:', this.isCapturing, 'paused:', this.isPaused)
      return
    }
    this.lastChunkAt = Date.now()
    if (this.flowState === 'stalled') {
      this.flowState = 'flowing'
      this.emit('flow-status', { state: 'flowing', stalledForMs: 0 } as AudioFlowStatus)
    }
    this.streamManager.feed(pcmData)
  }

  getIsCapturing(): boolean {
    return this.isCapturing
  }

  getFlowState(): AudioFlowState {
    return this.flowState
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatInterval = setInterval(() => this.checkFlow(), HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  private checkFlow(): void {
    if (!this.isCapturing || this.isPaused) return
    const gap = Date.now() - this.lastChunkAt
    if (gap > STALL_THRESHOLD_MS && this.flowState !== 'stalled') {
      this.flowState = 'stalled'
      console.warn(`[AudioCapture] No audio for ${gap}ms — emitting stalled`)
      this.emit('flow-status', { state: 'stalled', stalledForMs: gap } as AudioFlowStatus)
    }
  }

  // Test seam — let unit tests probe checkFlow without spinning a real timer.
  _tickForTests(): void {
    this.checkFlow()
  }
}
