import { createWriteStream, existsSync, unlinkSync, renameSync, readdirSync } from 'fs'
import { join } from 'path'
import type { WriteStream } from 'fs'
import { getRecordingsDir } from '../storage/paths'

interface ActiveRecording {
  meetingId: string
  tempPath: string
  stream: WriteStream
  bytesWritten: number
}

let activeRecording: ActiveRecording | null = null

export function startVideoFile(meetingId: string): void {
  if (activeRecording) {
    console.warn('[VideoWriter] Already recording, closing previous file')
    closeVideoFile()
  }

  const tempPath = join(getRecordingsDir(), `${meetingId}.webm.tmp`)
  const stream = createWriteStream(tempPath, { flags: 'w' })

  activeRecording = {
    meetingId,
    tempPath,
    stream,
    bytesWritten: 0
  }

  console.log(`[VideoWriter] Started writing to ${tempPath}`)
}

export function appendVideoChunk(meetingId: string, data: Buffer): void {
  if (!activeRecording || activeRecording.meetingId !== meetingId) {
    return
  }

  activeRecording.stream.write(data)
  activeRecording.bytesWritten += data.length
}

export function finalizeVideoFile(meetingId: string, filename: string): string {
  if (!activeRecording || activeRecording.meetingId !== meetingId) {
    throw new Error('No active video recording for this meeting')
  }

  const { tempPath, stream, bytesWritten } = activeRecording

  stream.end()
  activeRecording = null

  if (bytesWritten === 0) {
    if (existsSync(tempPath)) unlinkSync(tempPath)
    throw new Error('Video recording contains no data')
  }

  const finalPath = join(getRecordingsDir(), filename)
  renameSync(tempPath, finalPath)

  console.log(`[VideoWriter] Finalized ${finalPath} (${(bytesWritten / 1024 / 1024).toFixed(1)} MB)`)
  return filename
}

export function closeVideoFile(): void {
  if (!activeRecording) return
  activeRecording.stream.end()
  if (existsSync(activeRecording.tempPath)) {
    unlinkSync(activeRecording.tempPath)
  }
  activeRecording = null
}

export function cleanupOrphanedTempFiles(): void {
  const dir = getRecordingsDir()
  if (!existsSync(dir)) return
  const tmpFiles = readdirSync(dir).filter((f) => f.endsWith('.webm.tmp'))
  for (const f of tmpFiles) {
    unlinkSync(join(dir, f))
    console.log(`[VideoWriter] Cleaned up orphaned temp file: ${f}`)
  }
}
