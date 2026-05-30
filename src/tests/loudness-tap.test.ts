import { describe, expect, it } from 'vitest'
import { createLoudnessAccumulator, rmsDbFs } from '../renderer/audio/loudness-tap'

describe('rmsDbFs', () => {
  it('full-scale sine reads near 0 dBFS', () => {
    const samples = new Float32Array(1024)
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000)
    }
    const db = rmsDbFs(samples)
    // Full-scale sine RMS = 1/sqrt(2) ≈ 0.707 → -3.01 dBFS.
    expect(db).toBeGreaterThan(-3.1)
    expect(db).toBeLessThan(-2.9)
  })

  it('returns -Infinity on silence', () => {
    expect(rmsDbFs(new Float32Array(128))).toBe(-Infinity)
  })

  it('returns -Infinity on empty buffer', () => {
    expect(rmsDbFs(new Float32Array(0))).toBe(-Infinity)
  })

  it('-20 dBFS sine reads in expected range', () => {
    const samples = new Float32Array(1024)
    const amplitude = 0.1 // -20 dBFS sine peak
    for (let i = 0; i < samples.length; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000)
    }
    const db = rmsDbFs(samples)
    // RMS = 0.0707 → -23.01 dBFS.
    expect(db).toBeGreaterThan(-23.5)
    expect(db).toBeLessThan(-22.5)
  })
})

describe('createLoudnessAccumulator', () => {
  it('drain returns null when no samples have been added', () => {
    const acc = createLoudnessAccumulator()
    expect(acc.drain()).toBeNull()
  })

  it('add then drain returns per-channel dBFS and resets', () => {
    const acc = createLoudnessAccumulator()
    const loud = new Float32Array(512).fill(0.5)
    const quiet = new Float32Array(512).fill(0.05)
    acc.add(0, loud)
    acc.add(1, quiet)

    const drained = acc.drain()
    expect(drained).not.toBeNull()
    expect(drained!.micDb).toBeGreaterThan(drained!.sysDb)
    // Subsequent drain returns null since state was reset.
    expect(acc.drain()).toBeNull()
  })

  it('accumulates across multiple add() calls before drain', () => {
    const acc = createLoudnessAccumulator()
    const oneFrame = new Float32Array(128).fill(0.3)
    acc.add(0, oneFrame)
    acc.add(0, oneFrame)
    acc.add(0, oneFrame)
    expect(acc.countFor(0)).toBe(384)
    const out = acc.drain()
    expect(out).not.toBeNull()
    // RMS of constant 0.3 = 0.3 → 20*log10(0.3) ≈ -10.46 dBFS.
    expect(out!.micDb).toBeGreaterThan(-10.6)
    expect(out!.micDb).toBeLessThan(-10.3)
  })

  it('a channel with no samples returns -Infinity on drain', () => {
    const acc = createLoudnessAccumulator()
    acc.add(0, new Float32Array(128).fill(0.5))
    const out = acc.drain()
    expect(out).not.toBeNull()
    expect(out!.sysDb).toBe(-Infinity)
  })
})
