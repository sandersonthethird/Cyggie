import { existsSync, unlinkSync, renameSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs'
import { join, extname, basename, dirname } from 'path'
import { spawn, spawnSync } from 'child_process'
import type { ChildProcessByStdio } from 'child_process'
import type { Readable, Writable } from 'stream'
import { once } from 'events'
import { getRecordingsDir, getStagingDir } from '../storage/paths'
import {
  isTwoTierStorageEnabled,
  placeFinalizedFile,
  resolveExistingFile,
  resolveRecordingFilePath,
  recordingProbeDirs,
  stagingPathFor,
} from '../storage/routing'
import { enqueueHeldFile } from '../storage/hold-queue'

interface MeetingRef {
  id: string
  isPrivate?: boolean | null
}

interface ActiveRecording {
  meetingId: string
  tempPath: string
  ffmpegPath: string
  // stdio is ['pipe', 'ignore', 'pipe']: stdin = Writable, stdout ignored
  // (null), stderr = Readable. Only stdin + stderr are accessed.
  process: ChildProcessByStdio<Writable, null, Readable>
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

/**
 * Returns the meetingId of the currently-active (in-progress, not yet stopped)
 * video recording, or null if none. The before-quit handler uses this to
 * prompt the user when they try to quit mid-recording.
 *
 * "Active" here means recording is ongoing — once VIDEO_STOP fires and
 * finalizeVideoFile sets activeRecording=null, this returns null even though
 * finalization may still be running in the background (track that separately
 * via pendingFinalizations in video.ipc.ts).
 */
export function getActiveRecordingMeetingId(): string | null {
  if (!activeRecording || activeRecording.isFinalizing) return null
  return activeRecording.meetingId
}

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

async function concatVideoFiles(
  ffmpegPath: string,
  inputPaths: string[],
  outputPath: string
): Promise<void> {
  const listPath = outputPath + '.concat.txt'
  const listContent = inputPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n')
  writeFileSync(listPath, listContent, 'utf-8')

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listPath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-y',
    outputPath
  ]

  try {
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
              `FFmpeg concat failed (exit ${code})${stderrLines.length ? `: ${stderrLines.join('\n')}` : ''}`
            )
          )
        }
      })
    })
  } finally {
    if (existsSync(listPath)) unlinkSync(listPath)
  }
}

function findRecordingByMeetingId(meetingId: string): string | null {
  // recordingProbeDirs() is [recordingsDir] when the flag is off (identical to
  // the original single-dir scan) and [private, shared, staging] when on.
  const dirs = recordingProbeDirs()
  const shortId = meetingId.split('-')[0]

  const candidates: Array<{ name: string; dir: string }> = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const lower = name.toLowerCase()
      const isMedia = lower.endsWith('.mp4') || lower.endsWith('.webm')
      if (!isMedia) continue
      if (
        name.includes(`(${shortId})`) ||
        name.startsWith(`${meetingId}.`) ||
        name.startsWith(meetingId) ||
        name.includes(meetingId)
      ) {
        candidates.push({ name, dir })
      }
    }
  }
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
    const scoreDiff = score(b.name) - score(a.name)
    if (scoreDiff !== 0) return scoreDiff
    try {
      const aMtime = statSync(join(a.dir, a.name)).mtimeMs
      const bMtime = statSync(join(b.dir, b.name)).mtimeMs
      return bMtime - aMtime
    } catch {
      return 0
    }
  })

  return candidates[0]?.name || null
}

export function resolveMeetingRecordingFilename(
  meetingId: string,
  recordingPath: string | null | undefined
): string | null {
  // resolveRecordingFilePath probes the single recordings dir (flag off) or both
  // roots + the held-staging slot (flag on), so the alternate-extension search
  // below transparently spans wherever the file actually landed.
  const normalized = (recordingPath || '').trim()
  if (normalized) {
    if (resolveRecordingFilePath(normalized)) {
      return normalized
    }

    const ext = extname(normalized)
    const base = basename(normalized, ext)
    const alternates = [`${base}.mp4`, `${base}.webm`, `${base}.play.mp4`]
    for (const alternate of alternates) {
      if (resolveRecordingFilePath(alternate)) {
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
  // Issue 2A: when two-tier is on, the in-progress capture streams to the local
  // staging dir (never a synced root) so a public-then-private toggle can't
  // pre-leak bytes to Drive. Placed into the routed root at finalize. Flag OFF →
  // the legacy recordings dir, byte-identical to before.
  const tempPath = isTwoTierStorageEnabled()
    ? join(getStagingDir(), `${meetingId}.tmp.mp4`)
    : join(getRecordingsDir(), `${meetingId}.tmp.mp4`)

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

export async function finalizeVideoFile(
  meetingId: string,
  filename: string,
  previousRecordingPath?: string,
  isPrivate?: boolean | null
): Promise<string> {
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

  if (!isTwoTierStorageEnabled()) {
    // ===== Legacy single-root finalize — byte-identical to pre-two-tier. =====
    const dir = getRecordingsDir()
    const finalPath = join(dir, filename)

    // Check for an existing recording to concatenate with
    const previousFullPath = previousRecordingPath
      ? join(dir, previousRecordingPath)
      : null

    if (previousFullPath && existsSync(previousFullPath)) {
      const prevTempPath = join(dir, `${meetingId}.prev.tmp.mp4`)
      renameSync(previousFullPath, prevTempPath)

      try {
        await concatVideoFiles(recording.ffmpegPath, [prevTempPath, tempPath], finalPath)
        // Clean up segment temp files
        if (existsSync(prevTempPath)) unlinkSync(prevTempPath)
        if (existsSync(tempPath)) unlinkSync(tempPath)
        console.log(
          `[VideoWriter] Concatenated segments into ${finalPath} (${recording.ffmpegPath})`
        )
      } catch (err) {
        console.warn('[VideoWriter] Concat failed, saving new segment only:', err)
        // Restore previous file and save new segment separately
        if (existsSync(prevTempPath)) {
          try {
            renameSync(prevTempPath, previousFullPath)
          } catch {
            // ignore
          }
        }
        renameSync(tempPath, finalPath)
      }
    } else {
      renameSync(tempPath, finalPath)
      console.log(
        `[VideoWriter] Finalized ${finalPath} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB via ${recording.ffmpegPath})`
      )
    }

    return filename
  }

  // ===== Two-tier finalize: stage→place into the routed root, HOLD when the
  // public shared root is unresolved (Issue 3A). =====
  const meeting: MeetingRef = { id: meetingId, isPrivate }
  // Canonical local staging slot. placeFinalizedFile moves it into the routed
  // root, or — on HOLD — leaves it here, where resolveExistingFile's staging
  // fallback still finds it for playback.
  const canonicalStaging = stagingPathFor('recording', filename)
  mkdirSync(dirname(canonicalStaging), { recursive: true })

  // A prior segment may live in EITHER root (or held in staging) — resolve
  // across them before concatenating.
  const previousResolved = previousRecordingPath
    ? resolveExistingFile(meeting, 'recording', previousRecordingPath)
    : null

  if (previousResolved && existsSync(previousResolved)) {
    // Concat the previous segment (read in place) + the new staged segment into a
    // DISTINCT combined temp, so input and output never alias when the previous
    // segment is itself the held same-named file.
    const combinedTemp = join(getStagingDir(), `${meetingId}.combined.tmp.mp4`)
    try {
      await concatVideoFiles(recording.ffmpegPath, [previousResolved, tempPath], combinedTemp)
      if (existsSync(tempPath)) unlinkSync(tempPath)
      // The combined file subsumes the previous segment — drop it, then move the
      // combined result into the canonical staging slot.
      if (existsSync(previousResolved)) unlinkSync(previousResolved)
      renameSync(combinedTemp, canonicalStaging)
      console.log(`[VideoWriter] Concatenated segments (${recording.ffmpegPath})`)
    } catch (err) {
      console.warn('[VideoWriter] Concat failed, saving new segment only:', err)
      if (existsSync(combinedTemp)) {
        try {
          unlinkSync(combinedTemp)
        } catch {
          // ignore
        }
      }
      // Keep the previous segment intact; stage just the new segment.
      renameSync(tempPath, canonicalStaging)
    }
  } else {
    renameSync(tempPath, canonicalStaging)
  }

  const placed = placeFinalizedFile(meeting, 'recording', filename, canonicalStaging)
  if (placed.kind === 'held') {
    // The file waits in staging (still readable via the resolve-staging
    // fallback). Enqueue so the held-finalize queue drains it into the shared
    // root once it recovers (Slice 3e).
    enqueueHeldFile({ meetingId, kind: 'recording', filename, stagingPath: placed.stagingPath })
    console.warn(
      `[VideoWriter] Recording HELD — shared root unresolved, staged at ${placed.stagingPath}`
    )
  } else {
    console.log(
      `[VideoWriter] Finalized ${placed.path} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB via ${recording.ffmpegPath})`
    )
  }

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

  const sourcePath = resolveRecordingFilePath(filename)
  if (!sourcePath) {
    return filename
  }

  const playbackFilename = buildPlaybackFilename(filename)
  // Co-locate the playback copy with its source root (private / shared / staging)
  // so the media:// two-root probe serves it from wherever the source lives.
  const playbackPath = join(dirname(sourcePath), playbackFilename)
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
  // Flag ON: in-progress / concat temps live in the local staging dir, so sweep
  // it too. (Held canonical recordings sit in staging's `recording/` subdir with
  // real filenames — they don't match the temp patterns and are left untouched.)
  const dirs = isTwoTierStorageEnabled()
    ? [getRecordingsDir(), getStagingDir()]
    : [getRecordingsDir()]
  const isTemp = (f: string): boolean =>
    f.endsWith('.webm.tmp') ||
    f.endsWith('.mp4.tmp') ||
    f.endsWith('.tmp.mp4') || // also matches .prev.tmp.mp4 / .combined.tmp.mp4
    f.endsWith('.concat.txt')
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!isTemp(f)) continue
      unlinkSync(join(dir, f))
      console.log(`[VideoWriter] Cleaned up orphaned temp file: ${f}`)
    }
  }
}
