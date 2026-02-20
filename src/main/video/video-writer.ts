import { existsSync, unlinkSync, renameSync, readdirSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import { spawn, spawnSync } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { once } from 'events'
import { getRecordingsDir } from '../storage/paths'

interface ActiveRecording {
  meetingId: string
  tempPath: string
  ffmpegPath: string
  process: ChildProcessWithoutNullStreams
  bytesWritten: number
  pendingWrite: Promise<void>
  error: Error | null
  isFinalizing: boolean
  stderrLines: string[]
  exitCode: number | null
  exitPromise: Promise<number>
}

let activeRecording: ActiveRecording | null = null
const playbackConversionJobs = new Map<string, Promise<string>>()
const encoderListCache = new Map<string, Set<string>>()

interface EncoderConfig {
  video: string
  audio: 'aac' | null
}

function resolveFfmpegPath(): string {
  const configured =
    process.env['GORP_FFMPEG_PATH'] ||
    process.env['CYGGIE_FFMPEG_PATH'] ||
    process.env['FFMPEG_PATH']
  if (configured) return configured

  try {
    // Optional dependency in packaged builds.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpegStatic = require('ffmpeg-static') as string | null
    if (ffmpegStatic) return ffmpegStatic
  } catch {
    // Ignore missing optional package and fall back to PATH lookup.
  }

  // Common macOS/Homebrew install paths (GUI apps often lack shell PATH entries).
  const commonPaths = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg'
  ]
  for (const path of commonPaths) {
    if (existsSync(path)) return path
  }

  return 'ffmpeg'
}

function ensureFfmpegAvailable(ffmpegPath: string): void {
  const probe = spawnSync(ffmpegPath, ['-version'], { encoding: 'utf-8' })
  if (probe.error) {
    throw new Error(
      `FFmpeg not found at "${ffmpegPath}". Install FFmpeg or set GORP_FFMPEG_PATH (or CYGGIE_FFMPEG_PATH).`
    )
  }
  if (probe.status !== 0) {
    const stderr = (probe.stderr || '').trim()
    throw new Error(`FFmpeg is unavailable: ${stderr || `exit code ${probe.status}`}`)
  }
}

function getAvailableEncoders(ffmpegPath: string): Set<string> {
  const cached = encoderListCache.get(ffmpegPath)
  if (cached) return cached

  const encoders = new Set<string>()
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'], {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024
  })
  if (!probe.error && probe.status === 0) {
    for (const line of probe.stdout.split('\n')) {
      const match = line.match(/^\s*[A-Z\.]{6}\s+([^\s]+)/)
      if (match?.[1]) {
        encoders.add(match[1])
      }
    }
  }

  encoderListCache.set(ffmpegPath, encoders)
  return encoders
}

function resolveEncoderConfig(ffmpegPath: string): EncoderConfig {
  const encoders = getAvailableEncoders(ffmpegPath)
  const video =
    (['libx264', 'h264_videotoolbox', 'mpeg4'].find((encoder) => encoders.has(encoder)) ??
      'mpeg4')
  const audio: 'aac' | null = encoders.has('aac') ? 'aac' : null
  return { video, audio }
}

function buildVideoEncoderArgs(videoEncoder: string): string[] {
  if (videoEncoder === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p']
  }
  if (videoEncoder === 'h264_videotoolbox') {
    return ['-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p']
  }
  return ['-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p']
}

function buildAudioEncoderArgs(audioEncoder: EncoderConfig['audio']): string[] {
  if (audioEncoder === 'aac') {
    return ['-c:a', 'aac', '-b:a', '128k']
  }
  return ['-an']
}

function buildPlaybackFilename(sourceFilename: string): string {
  const ext = extname(sourceFilename)
  const base = basename(sourceFilename, ext)
  return `${base}.play.mp4`
}

function findRecordingByMeetingId(meetingId: string): string | null {
  const dir = getRecordingsDir()
  if (!existsSync(dir)) return null

  const shortId = meetingId.split('-')[0]
  const candidates = readdirSync(dir).filter((name) => {
    const lower = name.toLowerCase()
    const isMedia = lower.endsWith('.mp4') || lower.endsWith('.webm')
    if (!isMedia) return false
    return (
      name.includes(`(${shortId})`) ||
      name.startsWith(`${meetingId}.`) ||
      name.startsWith(meetingId) ||
      name.includes(meetingId)
    )
  })
  if (candidates.length === 0) return null

  const score = (name: string): number => {
    let value = 0
    if (name.includes(`(${shortId})`)) value += 100
    if (name.startsWith(`${meetingId}.`) || name.startsWith(meetingId)) value += 80
    if (name.includes(meetingId)) value += 50
    if (name.toLowerCase().endsWith('.play.mp4')) value += 5
    if (name.toLowerCase().endsWith('.tmp.mp4')) value -= 25
    return value
  }

  candidates.sort((a, b) => {
    const scoreDiff = score(b) - score(a)
    if (scoreDiff !== 0) return scoreDiff
    try {
      const aMtime = statSync(join(dir, a)).mtimeMs
      const bMtime = statSync(join(dir, b)).mtimeMs
      return bMtime - aMtime
    } catch {
      return 0
    }
  })

  return candidates[0] || null
}

export function resolveMeetingRecordingFilename(
  meetingId: string,
  recordingPath: string | null | undefined
): string | null {
  const dir = getRecordingsDir()
  const normalized = (recordingPath || '').trim()
  if (normalized) {
    const fullPath = join(dir, normalized)
    if (existsSync(fullPath)) {
      return normalized
    }

    const ext = extname(normalized)
    const base = basename(normalized, ext)
    const alternates = [`${base}.mp4`, `${base}.webm`, `${base}.play.mp4`]
    for (const alternate of alternates) {
      if (existsSync(join(dir, alternate))) {
        return alternate
      }
    }
  }

  return findRecordingByMeetingId(meetingId)
}

export function startVideoFile(meetingId: string): void {
  if (activeRecording) {
    console.warn('[VideoWriter] Already recording, closing previous file')
    closeVideoFile()
  }

  const ffmpegPath = resolveFfmpegPath()
  ensureFfmpegAvailable(ffmpegPath)
  const encoderConfig = resolveEncoderConfig(ffmpegPath)
  const tempPath = join(getRecordingsDir(), `${meetingId}.tmp.mp4`)

  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-fflags',
    '+genpts',
    '-analyzeduration',
    '100M',
    '-probesize',
    '100M',
    '-f',
    'webm',
    '-i',
    'pipe:0',
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    ...buildVideoEncoderArgs(encoderConfig.video),
    ...buildAudioEncoderArgs(encoderConfig.audio),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    tempPath
  ]

  const process = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['pipe', 'ignore', 'pipe']
  })

  let resolveExit: (code: number) => void = () => {}
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve
  })

  const stderrLines: string[] = []
  process.stderr.on('data', (chunk: Buffer) => {
    const lines = chunk.toString('utf-8').trim().split('\n').filter(Boolean)
    stderrLines.push(...lines)
    if (stderrLines.length > 20) {
      stderrLines.splice(0, stderrLines.length - 20)
    }
  })

  const recording: ActiveRecording = {
    meetingId,
    tempPath,
    ffmpegPath,
    process,
    bytesWritten: 0,
    pendingWrite: Promise.resolve(),
    error: null,
    isFinalizing: false,
    stderrLines,
    exitCode: null,
    exitPromise
  }
  activeRecording = recording

  process.once('error', (err) => {
    if (!recording.error) recording.error = err
  })
  process.once('exit', (code, signal) => {
    const normalizedCode = code ?? (signal ? 1 : 0)
    recording.exitCode = normalizedCode
    resolveExit(normalizedCode)
  })

  console.log(
    `[VideoWriter] Started FFmpeg recording to ${tempPath} (${ffmpegPath}; v=${encoderConfig.video}, a=${encoderConfig.audio ?? 'none'})`
  )
}

export function appendVideoChunk(meetingId: string, data: Buffer): void {
  if (!activeRecording || activeRecording.meetingId !== meetingId) {
    return
  }
  if (activeRecording.isFinalizing || activeRecording.error) {
    return
  }

  const recording = activeRecording
  recording.pendingWrite = recording.pendingWrite
    .catch(() => {
      // Keep the queue alive even after a prior write failure.
    })
    .then(async () => {
      if (recording.error || recording.isFinalizing) return
      if (recording.process.stdin.destroyed || !recording.process.stdin.writable) {
        // FFmpeg can close stdin once it exits; avoid masking the real ffmpeg error.
        return
      }

      const ok = recording.process.stdin.write(data)
      recording.bytesWritten += data.length
      if (!ok) {
        await once(recording.process.stdin, 'drain')
      }
    })
    .catch((err: unknown) => {
      const normalized = err instanceof Error ? err : new Error(String(err))
      const errno = normalized as NodeJS.ErrnoException
      // Broken pipe/write-after-end generally means ffmpeg already terminated.
      if (errno.code === 'EPIPE' || /write after end/i.test(normalized.message)) {
        return
      }
      if (!recording.error) {
        recording.error = normalized
      }
    })
}

async function waitForProcessExit(recording: ActiveRecording, timeoutMs: number): Promise<number> {
  const timedOut = new Promise<number>((resolve) => {
    setTimeout(() => resolve(-999), timeoutMs)
  })
  const code = await Promise.race([recording.exitPromise, timedOut])
  if (code === -999) {
    recording.process.kill('SIGKILL')
    throw new Error('FFmpeg did not exit in time while finalizing recording')
  }
  return code
}

export async function finalizeVideoFile(meetingId: string, filename: string): Promise<string> {
  if (!activeRecording || activeRecording.meetingId !== meetingId) {
    throw new Error('No active video recording for this meeting')
  }

  const recording = activeRecording
  recording.isFinalizing = true
  await recording.pendingWrite

  const { tempPath, bytesWritten } = recording

  activeRecording = null

  if (bytesWritten === 0) {
    try {
      recording.process.stdin.end()
      recording.process.kill('SIGTERM')
    } catch {
      // ignore
    }
    if (existsSync(tempPath)) unlinkSync(tempPath)
    throw new Error('Video recording contains no data')
  }

  try {
    if (!recording.process.stdin.destroyed) {
      recording.process.stdin.end()
    }
  } catch {
    // ignore
  }
  const exitCode = await waitForProcessExit(recording, 20000)
  if (exitCode !== 0) {
    if (existsSync(tempPath)) unlinkSync(tempPath)
    const detail = recording.stderrLines.join('\n').trim()
    throw new Error(
      `FFmpeg failed while finalizing recording (exit ${exitCode})${detail ? `: ${detail}` : ''}`
    )
  }
  if (recording.error) {
    if (existsSync(tempPath)) unlinkSync(tempPath)
    throw recording.error
  }

  const finalPath = join(getRecordingsDir(), filename)
  renameSync(tempPath, finalPath)

  console.log(
    `[VideoWriter] Finalized ${finalPath} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB via ${recording.ffmpegPath})`
  )
  return filename
}

export function closeVideoFile(): void {
  if (!activeRecording) return

  const recording = activeRecording
  activeRecording = null
  recording.isFinalizing = true
  try {
    if (!recording.process.stdin.destroyed) {
      recording.process.stdin.end()
    }
  } catch {
    // ignore
  }
  try {
    recording.process.kill('SIGTERM')
  } catch {
    // ignore
  }

  if (existsSync(recording.tempPath)) {
    unlinkSync(recording.tempPath)
  }
}

async function transcodeToPlaybackMp4(sourcePath: string, outputPath: string): Promise<void> {
  const ffmpegPath = resolveFfmpegPath()
  ensureFfmpegAvailable(ffmpegPath)
  const encoderConfig = resolveEncoderConfig(ffmpegPath)

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    sourcePath,
    ...buildVideoEncoderArgs(encoderConfig.video),
    ...buildAudioEncoderArgs(encoderConfig.audio),
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderrLines: string[] = []

    proc.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf-8').trim().split('\n').filter(Boolean)
      stderrLines.push(...lines)
      if (stderrLines.length > 20) {
        stderrLines.splice(0, stderrLines.length - 20)
      }
    })

    proc.once('error', (err) => reject(err))
    proc.once('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(
          new Error(
            `FFmpeg playback transcode failed (exit ${code})${stderrLines.length ? `: ${stderrLines.join('\n')}` : ''}`
          )
        )
      }
    })
  })
}

export async function getPlayableRecordingFilename(filename: string): Promise<string> {
  if (!filename.toLowerCase().endsWith('.webm')) {
    return filename
  }

  const sourcePath = join(getRecordingsDir(), filename)
  if (!existsSync(sourcePath)) {
    return filename
  }

  const playbackFilename = buildPlaybackFilename(filename)
  const playbackPath = join(getRecordingsDir(), playbackFilename)
  if (existsSync(playbackPath)) {
    return playbackFilename
  }

  if (playbackConversionJobs.has(filename)) {
    return playbackConversionJobs.get(filename)!
  }

  const job = (async () => {
    try {
      await transcodeToPlaybackMp4(sourcePath, playbackPath)
      console.log(`[VideoWriter] Created playback copy: ${playbackFilename}`)
      return playbackFilename
    } catch (err) {
      console.warn('[VideoWriter] Failed to create playback copy, using original file:', err)
      return filename
    } finally {
      playbackConversionJobs.delete(filename)
    }
  })()

  playbackConversionJobs.set(filename, job)
  return job
}

export function cleanupOrphanedTempFiles(): void {
  const dir = getRecordingsDir()
  if (!existsSync(dir)) return
  const tmpFiles = readdirSync(dir).filter(
    (f) => f.endsWith('.webm.tmp') || f.endsWith('.mp4.tmp') || f.endsWith('.tmp.mp4')
  )
  for (const f of tmpFiles) {
    unlinkSync(join(dir, f))
    console.log(`[VideoWriter] Cleaned up orphaned temp file: ${f}`)
  }
}
