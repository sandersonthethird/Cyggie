/**
 * Per-channel loudness tap — pure TS, no Web Audio references.
 *
 * The AudioWorklet drives a short-time RMS accumulator per channel and
 * emits {tStart, tEnd, micDb, sysDb} samples to the renderer at ~10 Hz.
 * The renderer forwards those over IPC to RecordingSession, which
 * stores them aligned with the transcript timeline. At finalize the
 * me/them resolver correlates speaker segments with mic-vs-system
 * dominance to pick which speaker index is "me" in mono+system mode.
 *
 * This module exposes only the small numeric core (RMS → dBFS) so the
 * algorithm can be unit-tested without an AudioWorklet harness. The
 * worklet itself maintains its own rolling accumulator and timing —
 * the JS port lives inside `useAudioCapture.ts`'s buildWorkletModule
 * template alongside NLMS.
 */

/**
 * Root-mean-square of a sample buffer, converted to dBFS. Empty buffer
 * or all-zero input returns -Infinity (silence).
 *
 * dBFS = 20 * log10(rms). With samples in [-1, 1] from Web Audio, the
 * scale is 0 dBFS = full-scale sine, negative values = below full
 * scale. The resolver only ever compares pairs (mic vs system) so the
 * absolute reference doesn't matter — only the gap between channels.
 */
export function rmsDbFs(samples: ArrayLike<number>): number {
  const len = samples.length
  if (len === 0) return -Infinity
  let sumSq = 0
  for (let i = 0; i < len; i++) {
    const s = samples[i]
    sumSq += s * s
  }
  const rms = Math.sqrt(sumSq / len)
  if (rms === 0) return -Infinity
  return 20 * Math.log10(rms)
}

export interface LoudnessAccumulator {
  /** Add a frame to the active window for one channel. */
  add(channel: 0 | 1, samples: ArrayLike<number>): void
  /**
   * Return the dBFS for the active window on each channel and reset
   * accumulators. Returns null when no samples were added since the
   * last reset (avoids emitting `-Infinity` rows during silence).
   */
  drain(): { micDb: number; sysDb: number } | null
  /** Sample count seen on each channel since last drain. */
  countFor(channel: 0 | 1): number
}

/**
 * Cheap streaming accumulator: tracks sum-of-squares + count per
 * channel, returns dBFS on drain, clears state. The worklet calls
 * `add()` every render quantum (128 samples) and `drain()` whenever
 * its frame counter reaches the configured window length.
 */
export function createLoudnessAccumulator(): LoudnessAccumulator {
  let micSumSq = 0
  let sysSumSq = 0
  let micCount = 0
  let sysCount = 0

  function add(channel: 0 | 1, samples: ArrayLike<number>): void {
    let sumSq = 0
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i]
    if (channel === 0) {
      micSumSq += sumSq
      micCount += samples.length
    } else {
      sysSumSq += sumSq
      sysCount += samples.length
    }
  }

  function drain(): { micDb: number; sysDb: number } | null {
    if (micCount === 0 && sysCount === 0) return null
    const micDb = sumSqToDb(micSumSq, micCount)
    const sysDb = sumSqToDb(sysSumSq, sysCount)
    micSumSq = 0
    sysSumSq = 0
    micCount = 0
    sysCount = 0
    return { micDb, sysDb }
  }

  function countFor(channel: 0 | 1): number {
    return channel === 0 ? micCount : sysCount
  }

  return { add, drain, countFor }
}

function sumSqToDb(sumSq: number, count: number): number {
  if (count === 0 || sumSq === 0) return -Infinity
  const rms = Math.sqrt(sumSq / count)
  return 20 * Math.log10(rms)
}
