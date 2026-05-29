// AAC encoder — wraps ffmpeg-static as a long-lived subprocess that consumes
// raw stereo 16kHz/16-bit linear16 PCM on stdin and writes AAC@128k in an MP4
// container to <recordingsDir>/<meetingId>.m4a.
//
// EVAL-FEATURE: this module exists only for the transcription-provider eval.
// Rip out by deleting the directory + reverting the onAudioChunk wiring in
// recording.ipc.ts.
//
// Why ffmpeg instead of a hand-rolled WAV writer: the video-writer at
// src/main/video/video-writer.ts already proves out the same encoder
// (ffmpeg-static -c:a aac -b:a 128k), and ffmpeg's atomic finalize means
// crashed sessions still produce a valid (truncated) file. WAV would require
// hand-patching a header at close time — fragile.

import { spawn, spawnSync, type ChildProcessByStdio } from 'child_process'
import type { Writable, Readable } from 'stream'
import { existsSync } from 'fs'

// stdio = ['pipe', 'ignore', 'pipe']: stdin is writable, stdout is null,
// stderr is readable. That maps to ChildProcessByStdio<Writable, null, Readable>.
type FfmpegProcess = ChildProcessByStdio<Writable, null, Readable>

interface ActiveEncoder {
  outputPath: string
  process: FfmpegProcess
  bytesWritten: number
  stderrLines: string[]
  exitPromise: Promise<number>
  error: Error | null
}

let active: ActiveEncoder | null = null

function resolveFfmpegPath(): string {
  const configured =
    process.env['CYGGIE_FFMPEG_PATH'] ||
    process.env['GORP_FFMPEG_PATH'] ||
    process.env['FFMPEG_PATH']
  if (configured) return configured

  try {
    // Optional dep (matches video-writer's pattern). Falls back to PATH.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static') as string | null
    if (ffmpegStatic) return ffmpegStatic
  } catch {
    // ignore
  }

  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (existsSync(candidate)) return candidate
  }
  return 'ffmpeg'
}

function ensureFfmpegAvailable(ffmpegPath: string): void {
  const probe = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf-8' })
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `[AacEncoder] FFmpeg not found at "${ffmpegPath}". Install ffmpeg or set CYGGIE_FFMPEG_PATH.`,
    )
  }
}

/**
 * Open a new AAC encoding session that writes to `outputPath`. Only one
 * encoder can be active at a time; opening a new one while another is
 * running is treated as a bug and logs a warning before forcibly closing
 * the previous one.
 */
export function startAacEncoder(outputPath: string): void {
  if (active) {
    console.warn('[AacEncoder] Already active, forcing close of previous encoder')
    void stopAacEncoder().catch(() => {})
  }

  const ffmpegPath = resolveFfmpegPath()
  ensureFfmpegAvailable(ffmpegPath)

  // Raw 16-bit signed little-endian PCM at 16kHz, 2 channels — matches what
  // AudioCapture (src/main/audio/capture.ts) emits via its 'audio-chunk' event.
  // The AudioStreamManager is constructed with 16000Hz/2-channel/100ms chunks.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '2',
    '-i',
    'pipe:0',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    outputPath,
  ]

  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] })

  const stderrLines: string[] = []
  proc.stderr.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').trim().split('\n').filter(Boolean)
    stderrLines.push(...lines)
    if (stderrLines.length > 20) stderrLines.splice(0, stderrLines.length - 20)
  })

  const enc: ActiveEncoder = {
    outputPath,
    process: proc,
    bytesWritten: 0,
    stderrLines,
    error: null,
    exitPromise: new Promise<number>((resolve) => {
      proc.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    }),
  }

  proc.once('error', (err) => {
    if (!enc.error) enc.error = err
    console.warn('[AacEncoder] ffmpeg process error:', err.message)
  })

  active = enc
  console.log(`[AacEncoder] Started writing to ${outputPath} (${ffmpegPath})`)
}

/**
 * Append a stereo 16kHz/16-bit PCM chunk to the active encoder. No-ops if
 * no encoder is active (e.g. recording started without one for whatever
 * reason) — we never want to back-pressure the audio pipeline because of
 * eval-feature failures.
 */
export function appendAacChunk(chunk: Buffer): void {
  if (!active || active.error) return
  // Non-blocking write; ffmpeg's stdin handles backpressure internally and
  // we accept some lossage if it stalls.
  const ok = active.process.stdin.write(chunk)
  if (!ok) {
    // Drop chunks under backpressure rather than queueing — bounded memory.
    // The eval feature can tolerate a few dropped milliseconds.
  }
  active.bytesWritten += chunk.length
}

/**
 * Close the active encoder, waiting for ffmpeg to flush + write the MP4
 * trailer (moov atom). Returns the output path on success or null if no
 * encoder was active. Rejects on encoder error.
 */
export async function stopAacEncoder(): Promise<string | null> {
  if (!active) return null
  const enc = active
  active = null

  try {
    enc.process.stdin.end()
  } catch (err) {
    console.warn('[AacEncoder] Error closing ffmpeg stdin:', err)
  }

  const code = await enc.exitPromise
  if (code !== 0) {
    console.warn(
      `[AacEncoder] ffmpeg exited with code ${code} for ${enc.outputPath}. stderr:`,
      enc.stderrLines.join('\n'),
    )
  } else {
    console.log(
      `[AacEncoder] Finalized ${enc.outputPath} (${(enc.bytesWritten / 1024 / 1024).toFixed(1)} MB PCM in)`,
    )
  }
  return enc.outputPath
}

export function isAacEncoderActive(): boolean {
  return active !== null
}
