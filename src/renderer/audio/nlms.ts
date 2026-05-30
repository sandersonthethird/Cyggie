/**
 * Normalized Least Mean Squares adaptive filter — pure TS, no Web Audio
 * or DOM references. Embedded into the AudioWorklet template at build
 * time and also importable directly under Vitest for unit testing.
 *
 * Purpose: estimate the system→mic acoustic leak path on the fly and
 * subtract predicted leak from the mic channel before it reaches Deepgram.
 * Solves the Zoom-bleed doubling problem that killed the previous
 * multichannel attempt (rolled back 2026-05-27).
 *
 * Algorithm (per-sample):
 *
 *   ref[ring]     = last L reference (system) samples
 *   w[0..L]       = filter coefficients
 *   y_hat         = Σ w[i] * ref[refHead - 1 - i]    // predicted leak
 *   e             = mic - y_hat                       // cleaned mic
 *   norm          = Σ ref[..]² + eps
 *   w[i]         += (mu * e * ref[..]) / norm         // adapt
 *
 * No correlation gate: when there's no acoustic bleed (e.g. headphones),
 * mic and reference are uncorrelated at every lag and the filter
 * naturally converges to w ≈ 0, leaving mic unchanged. Simpler than
 * gating, and the per-sample cost (one dot product + one MAC loop over
 * L=1024 taps at 16 kHz) is well within the worklet's CPU budget.
 *
 * Divergence detector: if any |w[i]| exceeds clipThreshold for more
 * than divergenceClipBudget samples in a rolling 1-second window, the
 * filter switches to passthrough permanently (until reset). The worklet
 * caller emits an `aec-degraded` event to the renderer which surfaces
 * a banner. Recording continues at mono-equivalent quality.
 */

export type NlmsState = 'adapting' | 'diverged'

export interface NlmsConfig {
  /** Number of filter taps. ~1024 at 16 kHz ≈ 64 ms of reverb tail. */
  taps: number
  /** Adaptation step size. Tune lower (e.g. 0.005) if divergence is common. */
  mu: number
  /** Coefficient magnitude that counts as a "clip" for the divergence detector. */
  clipThreshold: number
  /** Total clips allowed within a 1-second window before flagging divergence. */
  divergenceClipBudget: number
  /** Sample rate (used to size the divergence rolling window). */
  sampleRate: number
}

export const DEFAULT_NLMS_CONFIG: NlmsConfig = {
  taps: 1024,
  // mu=0.08 chosen empirically: fast enough to give ≥10× suppression on
  // a 2-second white-noise bleed scenario, slow enough that uncorrelated
  // input doesn't drive coefficients to instability. Lower if real-world
  // divergence events become common.
  mu: 0.08,
  clipThreshold: 4.0,
  divergenceClipBudget: 32,
  sampleRate: 16000,
}

export interface NlmsDiagnostics {
  state: NlmsState
  samplesSeen: number
  maxCoefficient: number
  clipsLastSecond: number
}

export interface NlmsFilter {
  /** Process one sample. Returns the cleaned mic sample (or unchanged mic if diverged). */
  process(micSample: number, refSample: number): number
  /** Zero out coefficients, clear state. Called on sample rate change. */
  reset(): void
  /** Current state for inspection. */
  getState(): NlmsState
  /** Whether divergence has fired since the last `reset()`. */
  isDiverged(): boolean
  /** Snapshot of internal stats for logging / tests. */
  getDiagnostics(): NlmsDiagnostics
}

/**
 * Factory. Returns a stateful filter object — one per recording session.
 * The worklet holds a single instance for the mic channel.
 */
export function createNlmsFilter(config: NlmsConfig = DEFAULT_NLMS_CONFIG): NlmsFilter {
  const taps = Math.max(1, Math.floor(config.taps))
  const w = new Float32Array(taps)
  const ref = new Float32Array(taps)
  let refHead = 0
  let state: NlmsState = 'adapting'
  let samplesSeen = 0

  // Divergence detection: rolling 1-second window approximated by
  // exponential decay. Avoids storing a per-sample clip ring.
  const divWindow = Math.max(config.sampleRate, 1000)
  let clipsInWindow = 0
  const clipDecayPerSample = 1 / divWindow

  function process(micSample: number, refSample: number): number {
    samplesSeen++

    ref[refHead] = refSample
    refHead = (refHead + 1) % taps

    if (state === 'diverged') {
      return micSample
    }

    // y_hat = Σ w[i] * ref[refHead - 1 - i]  (walking backward through ring)
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

    // NLMS update: w[i] += (mu * e * ref[i]) / (||ref||² + eps)
    const denom = normSq + 1e-6
    const muOverNorm = (config.mu * error) / denom
    let maxCoef = 0
    idx = refHead
    for (let i = 0; i < taps; i++) {
      idx = idx === 0 ? taps - 1 : idx - 1
      w[i] += muOverNorm * ref[idx]
      const absW = Math.abs(w[i])
      if (absW > maxCoef) maxCoef = absW
    }

    // Divergence accounting.
    clipsInWindow = Math.max(0, clipsInWindow - clipDecayPerSample)
    if (maxCoef >= config.clipThreshold) {
      clipsInWindow += 1
    }
    if (clipsInWindow >= config.divergenceClipBudget) {
      state = 'diverged'
      return micSample
    }

    return error
  }

  function reset(): void {
    w.fill(0)
    ref.fill(0)
    refHead = 0
    clipsInWindow = 0
    state = 'adapting'
    samplesSeen = 0
  }

  function getState(): NlmsState {
    return state
  }

  function isDiverged(): boolean {
    return state === 'diverged'
  }

  function getDiagnostics(): NlmsDiagnostics {
    let maxCoef = 0
    for (let i = 0; i < taps; i++) {
      const a = Math.abs(w[i])
      if (a > maxCoef) maxCoef = a
    }
    return {
      state,
      samplesSeen,
      maxCoefficient: maxCoef,
      clipsLastSecond: clipsInWindow,
    }
  }

  return { process, reset, getState, isDiverged, getDiagnostics }
}
