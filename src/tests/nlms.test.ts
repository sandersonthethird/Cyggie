import { describe, it, expect } from 'vitest'
import { createNlmsFilter, DEFAULT_NLMS_CONFIG } from '../renderer/audio/nlms'

const SR = 16000

/**
 * Generate a sine wave reference signal at `freq` Hz for `nSamples` samples.
 */
function sineWave(freq: number, nSamples: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(nSamples)
  for (let i = 0; i < nSamples; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR)
  }
  return out
}

/**
 * Simulate a simple acoustic leak: delayed + attenuated copy of the
 * reference appears on the mic channel.
 */
function makeBleed(reference: Float32Array, delaySamples: number, gain: number): Float32Array {
  const out = new Float32Array(reference.length)
  for (let i = 0; i < reference.length; i++) {
    out[i] = i >= delaySamples ? reference[i - delaySamples] * gain : 0
  }
  return out
}

/**
 * White noise generator with deterministic seed for reproducibility.
 */
function whiteNoise(nSamples: number, amplitude = 0.1, seed = 1): Float32Array {
  let s = seed
  const out = new Float32Array(nSamples)
  for (let i = 0; i < nSamples; i++) {
    s = (s * 9301 + 49297) % 233280
    out[i] = (s / 233280 - 0.5) * 2 * amplitude
  }
  return out
}

describe('createNlmsFilter', () => {
  it('starts in adapting state with zero coefficients', () => {
    const f = createNlmsFilter()
    expect(f.getState()).toBe('adapting')
    expect(f.isDiverged()).toBe(false)
    expect(f.getDiagnostics().maxCoefficient).toBe(0)
  })

  it('preserves mic energy when mic and reference are uncorrelated (headphone case)', () => {
    // No bleed scenario (e.g. headphones): mic is unrelated to reference.
    // The KEY property we want is that the OUTPUT stays close to the
    // input — the filter shouldn't accidentally cancel real speech that
    // happens to share spectrum with system audio. Coefficient magnitudes
    // will grow somewhat (uncorrelated input is not pathological for NLMS
    // — it just has a small Wiener-optimal solution that the LMS update
    // wanders toward), but the output energy stays close to mic energy.
    const f = createNlmsFilter()
    const mic = whiteNoise(SR, 0.1, 1)
    const ref = whiteNoise(SR, 0.1, 2)
    const out = new Float32Array(mic.length)
    for (let i = 0; i < mic.length; i++) {
      out[i] = f.process(mic[i], ref[i])
    }
    let outEnergy = 0
    let micEnergy = 0
    for (let i = mic.length - SR / 10; i < mic.length; i++) {
      outEnergy += out[i] * out[i]
      micEnergy += mic[i] * mic[i]
    }
    // Output should be within 3× of mic energy — i.e. NLMS does not
    // catastrophically alter uncorrelated content.
    expect(outEnergy).toBeGreaterThan(micEnergy * 0.3)
    expect(outEnergy).toBeLessThan(micEnergy * 3.0)
    // And filter is not in divergence.
    expect(f.isDiverged()).toBe(false)
  })

  it('converges to suppress system→mic bleed (white-noise reference)', () => {
    // Synthetic scenario: mic = delayed+attenuated copy of reference.
    // White noise is "persistently exciting" — NLMS converges fast on it.
    // 2 seconds of audio gives the filter time to stabilize.
    const seconds = 2
    const ref = whiteNoise(SR * seconds, 0.5, 42)
    const mic = makeBleed(ref, 8, 0.5)

    const f = createNlmsFilter()
    const out = new Float32Array(mic.length)
    for (let i = 0; i < mic.length; i++) {
      out[i] = f.process(mic[i], ref[i])
    }

    // Pre-NLMS energy: first 100ms of mic (un-cancelled).
    let preEnergy = 0
    for (let i = 0; i < SR / 10; i++) preEnergy += mic[i] * mic[i]
    // Post-NLMS energy: last 100ms of out (after convergence).
    let postEnergy = 0
    for (let i = mic.length - SR / 10; i < mic.length; i++) postEnergy += out[i] * out[i]

    // Expect ≥10× suppression on white-noise bleed.
    expect(postEnergy).toBeLessThan(preEnergy / 10)
  }, 30000)

  it('reset() zeros coefficients; subsequent adapt resumes from clean', () => {
    // Drive the filter to adapt, then reset, then verify the next batch
    // is at idle-with-zero-coefficients.
    const ref = sineWave(440, SR)
    const mic = makeBleed(ref, 8, 0.5)
    const f = createNlmsFilter()
    for (let i = 0; i < mic.length; i++) {
      f.process(mic[i], ref[i])
    }
    expect(f.getDiagnostics().maxCoefficient).toBeGreaterThan(0)

    f.reset()
    expect(f.getState()).toBe('adapting')
    expect(f.getDiagnostics().maxCoefficient).toBe(0)
    expect(f.getDiagnostics().samplesSeen).toBe(0)
  })

  it('flags divergence when forced into instability', () => {
    // Forcing divergence: lower the clip threshold so any adaptation
    // overshoots it. Then feed correlated input so the gate opens.
    const f = createNlmsFilter({
      ...DEFAULT_NLMS_CONFIG,
      clipThreshold: 0.001, // any nonzero coefficient counts as a clip
      divergenceClipBudget: 4, // very small budget — fires fast
      sampleRate: SR,
    })
    const ref = sineWave(440, SR / 10) // 100ms
    const mic = makeBleed(ref, 8, 0.5)
    for (let i = 0; i < mic.length; i++) {
      f.process(mic[i], ref[i])
    }
    expect(f.isDiverged()).toBe(true)
    expect(f.getState()).toBe('diverged')
  })

  it('after divergence, all subsequent samples passthrough unchanged', () => {
    // Force divergence quickly.
    const f = createNlmsFilter({
      ...DEFAULT_NLMS_CONFIG,
      clipThreshold: 0.001,
      divergenceClipBudget: 4,
      sampleRate: SR,
    })
    const ref = sineWave(440, SR / 10)
    const mic = makeBleed(ref, 8, 0.5)
    for (let i = 0; i < mic.length; i++) {
      f.process(mic[i], ref[i])
    }
    expect(f.isDiverged()).toBe(true)

    // Now process new samples. mic should come back unchanged.
    for (let i = 0; i < 100; i++) {
      const m = 0.42
      const r = 0.17
      const out = f.process(m, r)
      expect(out).toBe(m)
    }
  })

  it('reset() recovers from divergence', () => {
    const f = createNlmsFilter({
      ...DEFAULT_NLMS_CONFIG,
      clipThreshold: 0.001,
      divergenceClipBudget: 4,
      sampleRate: SR,
    })
    const ref = sineWave(440, SR / 10)
    const mic = makeBleed(ref, 8, 0.5)
    for (let i = 0; i < mic.length; i++) {
      f.process(mic[i], ref[i])
    }
    expect(f.isDiverged()).toBe(true)
    f.reset()
    expect(f.isDiverged()).toBe(false)
    expect(f.getState()).toBe('adapting')
  })

  it('passthrough when mic = 0 (no signal)', () => {
    const f = createNlmsFilter()
    for (let i = 0; i < 1000; i++) {
      const out = f.process(0, 0)
      expect(out).toBe(0)
    }
    expect(f.getState()).toBe('adapting')
  })
})
