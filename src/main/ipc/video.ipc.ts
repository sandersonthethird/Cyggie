import { desktopCapturer, ipcMain, session } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  startVideoFile,
  appendVideoChunk,
  finalizeVideoFile,
  getPlayableRecordingFilename,
  resolveMeetingRecordingFilename
} from '../video/video-writer'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import { buildRecordingFilename } from '../storage/file-manager'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'
import { findMeetingWindow } from '../audio/window-detector'
import { addPending, removePending } from './_finalizations'
import { broadcast } from './_broadcast'

/**
 * Pending video finalizations live in the shared registry at
 * `src/main/ipc/_finalizations.ts` under the `'video:<meetingId>'` key.
 * VIDEO_STOP returns optimistically after ~10ms and runs finalizeVideoFile
 * (FFmpeg flush + optional concat, typically 2–5s) in the background.
 *
 * Lifecycle:
 *   VIDEO_STOP   →   addPending('video', meetingId, promise)
 *                ↓
 *   finalize ok  →   updateMeeting({recordingPath}) + broadcast FINALIZED
 *   finalize err →   broadcast FINALIZE_ERROR (DB untouched)
 *                ↓
 *   .finally()   →   removePending('video', meetingId)
 */

// findMeetingWindow moved to ../audio/window-detector (shared with auto-stop's
// title patterns live in MEETING_APPS).

export function registerVideoHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.VIDEO_START, (_event, meetingId: string) => {
    startVideoFile(meetingId)
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_CHUNK, async (_event, meetingId: string, data: ArrayBuffer) => {
    appendVideoChunk(meetingId, Buffer.from(data))
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_STOP, async (_event, meetingId: string) => {
    const meeting = meetingRepo.getMeeting(meetingId)
    if (!meeting) throw new Error('Meeting not found')

    const filename = buildRecordingFilename(
      meetingId,
      meeting.title,
      meeting.date,
      meeting.attendees
    )
    const previousRecordingPath = meeting.recordingPath || undefined

    // Run finalization in the background — UI unblocks immediately. DB is
    // updated only on success so VIDEO_GET_PATH never sees a path to a
    // missing file. Failure broadcasts an error event the renderer must
    // surface; silence would be a data-loss bug.
    const finalizePromise = (async () => {
      try {
        await finalizeVideoFile(meetingId, filename, previousRecordingPath, meeting.isPrivate)
        meetingRepo.updateMeeting(meetingId, { recordingPath: filename })
        broadcast(IPC_CHANNELS.VIDEO_FINALIZED, { meetingId, filename })
      } catch (err) {
        console.error(`[VIDEO_STOP] finalize failed for ${meetingId}:`, err)
        broadcast(IPC_CHANNELS.VIDEO_FINALIZE_ERROR, {
          meetingId,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        removePending('video', meetingId)
      }
    })()
    addPending('video', meetingId, finalizePromise)

    return { success: true, filename }
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_GET_PATH, async (_event, meetingId: string) => {
    // Lite read: this handler only needs recordingPath, never the transcript.
    const meeting = meetingRepo.getMeetingLite(meetingId)
    if (!meeting) return null

    const resolvedFilename = resolveMeetingRecordingFilename(meetingId, meeting.recordingPath)
    if (!resolvedFilename) return null

    if (meeting.recordingPath !== resolvedFilename) {
      meetingRepo.updateMeeting(meetingId, { recordingPath: resolvedFilename })
    }

    const playableFilename = await getPlayableRecordingFilename(resolvedFilename)
    return `media://recordings/${encodeURIComponent(playableFilename)}`
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_FIND_WINDOW, async (_event, platform: string) => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const match = findMeetingWindow(sources, platform as MeetingPlatform)
    if (!match) {
      console.log(
        `[VideoCapture] No ${platform} window found. Available:`,
        sources.map((s) => s.name)
      )
      return null
    }
    console.log(`[VideoCapture] Found ${platform} window: "${match.name}" (${match.id})`)
    return { sourceId: match.id, name: match.name }
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_SET_WINDOW_SOURCE, async (_event, sourceId: string) => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 }
    })
    const source = sources.find((s) => s.id === sourceId)
    if (!source) throw new Error('Window source no longer available')

    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      callback({ video: source })
    })
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_CLEAR_WINDOW_SOURCE, () => {
    session.defaultSession.setDisplayMediaRequestHandler(null)
  })
}
