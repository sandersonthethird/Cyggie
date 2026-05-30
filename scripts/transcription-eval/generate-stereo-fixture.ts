#!/usr/bin/env node
/* eslint-disable no-console */
// EVAL-FEATURE: synthesize a 2-channel WAV that simulates the worst-case
// stereo recording scenario the cheeky-treasure plan needed to harden
// against: remote voice on system loopback + bleed copy on the mic.
//
// Output is 16 kHz / 16-bit / stereo PCM in WAV — a format both Deepgram
// batch and AssemblyAI batch APIs accept directly. Drop into
// `eval-fixtures/` and reference from the eval CLI (--audio=...).
//
// Channel 0 (mic):
//   - Synthesized "me" voice (a band-limited noise burst with formant-
//     ish filtering) at conversational intervals
//   - Plus the system signal attenuated by `bleedDb` and delayed by
//     `bleedDelayMs` to model the speaker→mic acoustic path
//
// Channel 1 (system loopback):
//   - Synthesized "remote" voice — different fundamental tone so
//     the dedup pass has something to fingerprint independently
//
// This is NOT a substitute for real speech. The goal is to drive the
// NLMS adapter into convergence on a deterministic signal so the
// downstream eval harness can assert "stereo + AEC beats mono" without
// API-cost variance. For WER comparisons against real Deepgram,
// substitute a public-domain podcast clip on channel 1 and your own
// TTS-rendered mic track on channel 0.
//
// Usage:
//   npx tsx scripts/transcription-eval/generate-stereo-fixture.ts \
//     --out=./eval-fixtures/stereo-bleed.wav \
//     --duration=45 \
//     --bleed-db=-18

import { writeFile, mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'

interface CliArgs {
  out: string
  durationSec: number
  bleedDb: number
  bleedDelayMs: number
  sampleRate: number
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: './eval-fixtures/stereo-bleed.wav',
    durationSec: 45,
    bleedDb: -18,
    bleedDelayMs: 12,
    sampleRate: 16000,
  }
  for (const a of argv.slice(2)) {
    if (a.startsWith('--out=')) args.out = a.slice('--out='.length)
    else if (a.startsWith('--duration=')) args.durationSec = Number(a.slice('--duration='.length))
    else if (a.startsWith('--bleed-db=')) args.bleedDb = Number(a.slice('--bleed-db='.length))
    else if (a.startsWith('--bleed-delay-ms=')) args.bleedDelayMs = Number(a.slice('--bleed-delay-ms='.length))
    else if (a.startsWith('--sr=')) args.sampleRate = Number(a.slice('--sr='.length))
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: generate-stereo-fixture --out=PATH [--duration=45] [--bleed-db=-18]`)
      process.exit(0)
    }
  }
  return args
}

interface TurnSpec {
  startSec: number
  endSec: number
  fundamentalHz: number
  amplitude: number
}

function buildTurns(durationSec: number): { mic: TurnSpec[]; sys: TurnSpec[] } {
  const mic: TurnSpec[] = []
  const sys: TurnSpec[] = []
  // Alternate ~3s turns starting with system (remote greets first).
  let t = 0
  let isSys = true
  while (t < durationSec - 3) {
    const len = 2.5 + Math.random() * 1.5
    const turn: TurnSpec = {
      startSec: t,
      endSec: Math.min(t + len, durationSec),
      fundamentalHz: isSys ? 180 : 240,
      amplitude: 0.45,
    }
    ;(isSys ? sys : mic).push(turn)
    t = turn.endSec + 0.3 + Math.random() * 0.4
    isSys = !isSys
  }
  return { mic, sys }
}

function synthVoice(samples: Float32Array, sampleRate: number, turns: TurnSpec[]): void {
  for (const turn of turns) {
    const startIdx = Math.floor(turn.startSec * sampleRate)
    const endIdx = Math.min(samples.length, Math.floor(turn.endSec * sampleRate))
    const fundamental = turn.fundamentalHz
    // Light "voiced" envelope: fundamental + 2nd + 3rd harmonics, modulated
    // by a slow ~6 Hz envelope to give the worklet's NLMS adapter something
    // with real spectral content to chase.
    for (let i = startIdx; i < endIdx; i++) {
      const t = (i - startIdx) / sampleRate
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 6 * t)
      const tone =
        Math.sin(2 * Math.PI * fundamental * t) +
        0.4 * Math.sin(2 * Math.PI * fundamental * 2 * t) +
        0.2 * Math.sin(2 * Math.PI * fundamental * 3 * t)
      samples[i] = (samples[i] ?? 0) + turn.amplitude * env * tone
    }
  }
}

function applyBleed(
  mic: Float32Array,
  sys: Float32Array,
  bleedDb: number,
  bleedDelaySamples: number,
): void {
  const gain = Math.pow(10, bleedDb / 20)
  for (let i = 0; i < mic.length; i++) {
    const srcIdx = i - bleedDelaySamples
    if (srcIdx < 0) continue
    mic[i] += gain * sys[srcIdx]
  }
  // Clip to [-1, 1] before int16 quantization.
  for (let i = 0; i < mic.length; i++) {
    if (mic[i] > 1) mic[i] = 1
    else if (mic[i] < -1) mic[i] = -1
  }
}

function interleaveAndQuantize(mic: Float32Array, sys: Float32Array): Int16Array {
  const out = new Int16Array(mic.length * 2)
  for (let i = 0; i < mic.length; i++) {
    out[i * 2] = floatToInt16(mic[i])
    out[i * 2 + 1] = floatToInt16(sys[i])
  }
  return out
}

function floatToInt16(sample: number): number {
  const c = Math.max(-1, Math.min(1, sample))
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff)
}

function buildWavHeader(
  pcmByteLength: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcmByteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM subchunk size
  header.writeUInt16LE(1, 20) // PCM = 1
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcmByteLength, 40)
  return header
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const totalSamples = Math.floor(args.durationSec * args.sampleRate)
  const mic = new Float32Array(totalSamples)
  const sys = new Float32Array(totalSamples)

  const turns = buildTurns(args.durationSec)
  synthVoice(mic, args.sampleRate, turns.mic)
  synthVoice(sys, args.sampleRate, turns.sys)

  const bleedDelaySamples = Math.floor((args.bleedDelayMs / 1000) * args.sampleRate)
  applyBleed(mic, sys, args.bleedDb, bleedDelaySamples)

  const interleaved = interleaveAndQuantize(mic, sys)
  const pcm = Buffer.from(interleaved.buffer)
  const header = buildWavHeader(pcm.length, args.sampleRate, 2, 16)

  const outPath = resolve(process.cwd(), args.out)
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, Buffer.concat([header, pcm]))

  console.log(
    `[generate-stereo-fixture] wrote ${outPath}`,
    `(${args.durationSec}s, mic-turns=${turns.mic.length}, sys-turns=${turns.sys.length},`,
    `bleed=${args.bleedDb}dB @${args.bleedDelayMs}ms delay)`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
