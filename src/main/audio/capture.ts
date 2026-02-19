import { EventEmitter } from 'events'
import { AudioStreamManager } from './stream-manager'

export type AudioCaptureSource = 'system' | 'microphone'

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
    this.streamManager.start()
    this.emit('started')
  }

  stop(): void {
    if (!this.isCapturing) return
    this.isCapturing = false
    this.isPaused = false
    this.streamManager.stop()
    this.emit('stopped')
  }

  pause(): void {
    this.isPaused = true
  }

  resume(): void {
    this.isPaused = false
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
    this.streamManager.feed(pcmData)
  }

  getIsCapturing(): boolean {
    return this.isCapturing
  }
}
