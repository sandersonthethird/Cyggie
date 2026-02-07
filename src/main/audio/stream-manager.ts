import { EventEmitter } from 'events'

/**
 * Normalizes and buffers audio chunks for Deepgram consumption.
 * Accepts PCM audio data and emits chunks in the format:
 * - linear16 (16-bit signed integer)
 * - 16000 Hz sample rate
 * - mono (1 channel)
 */
export class AudioStreamManager extends EventEmitter {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly chunkSize: number
  private isActive = false

  constructor(
    private sourceSampleRate: number = 16000,
    private sourceChannels: number = 1,
    chunkDurationMs: number = 100
  ) {
    super()
    // Calculate chunk size: sample_rate * channels * bytes_per_sample * duration_s
    this.chunkSize = Math.floor(
      (this.sourceSampleRate * this.sourceChannels * 2 * chunkDurationMs) / 1000
    )
  }

  start(): void {
    this.isActive = true
    this.buffer = Buffer.alloc(0)
  }

  stop(): void {
    this.isActive = false
    // Flush remaining buffer
    if (this.buffer.length > 0) {
      this.emit('chunk', this.buffer)
      this.buffer = Buffer.alloc(0)
    }
  }

  /**
   * Feed raw PCM audio data. The manager will buffer and emit
   * appropriately-sized chunks.
   */
  feed(data: Buffer): void {
    if (!this.isActive) return

    this.buffer = Buffer.concat([this.buffer, data])

    while (this.buffer.length >= this.chunkSize) {
      const chunk = this.buffer.subarray(0, this.chunkSize)
      this.buffer = this.buffer.subarray(this.chunkSize)
      this.emit('chunk', chunk)
    }
  }

  /**
   * Convert stereo PCM to mono by averaging channels.
   */
  static stereoToMono(stereoData: Buffer): Buffer {
    const sampleCount = stereoData.length / 4 // 2 bytes per sample, 2 channels
    const monoData = Buffer.alloc(sampleCount * 2)

    for (let i = 0; i < sampleCount; i++) {
      const left = stereoData.readInt16LE(i * 4)
      const right = stereoData.readInt16LE(i * 4 + 2)
      const mono = Math.round((left + right) / 2)
      monoData.writeInt16LE(mono, i * 2)
    }

    return monoData
  }

  /**
   * Resample PCM from one sample rate to another (simple linear interpolation).
   */
  static resample(data: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return data

    const ratio = fromRate / toRate
    const inputSamples = data.length / 2
    const outputSamples = Math.floor(inputSamples / ratio)
    const output = Buffer.alloc(outputSamples * 2)

    for (let i = 0; i < outputSamples; i++) {
      const srcIndex = i * ratio
      const srcIndexFloor = Math.floor(srcIndex)
      const frac = srcIndex - srcIndexFloor

      const s1 = data.readInt16LE(Math.min(srcIndexFloor, inputSamples - 1) * 2)
      const s2 = data.readInt16LE(Math.min(srcIndexFloor + 1, inputSamples - 1) * 2)
      const sample = Math.round(s1 + (s2 - s1) * frac)

      output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }

    return output
  }
}
