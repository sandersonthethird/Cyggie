import { ipcMain } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  startVideoFile,
  appendVideoChunk,
  finalizeVideoFile
} from '../video/video-writer'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { buildRecordingFilename } from '../storage/file-manager'
import { getRecordingsDir } from '../storage/paths'

export function registerVideoHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.VIDEO_START, (_event, meetingId: string) => {
    startVideoFile(meetingId)
  })

  ipcMain.on(IPC_CHANNELS.VIDEO_CHUNK, (_event, meetingId: string, data: ArrayBuffer) => {
    appendVideoChunk(meetingId, Buffer.from(data))
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_STOP, (_event, meetingId: string) => {
    const meeting = meetingRepo.getMeeting(meetingId)
    if (!meeting) throw new Error('Meeting not found')

    const filename = buildRecordingFilename(
      meetingId,
      meeting.title,
      meeting.date,
      meeting.attendees
    )

    finalizeVideoFile(meetingId, filename)

    meetingRepo.updateMeeting(meetingId, {
      recordingPath: filename
    })

    return { success: true, filename }
  })

  ipcMain.handle(IPC_CHANNELS.VIDEO_GET_PATH, (_event, meetingId: string) => {
    const meeting = meetingRepo.getMeeting(meetingId)
    if (!meeting?.recordingPath) return null
    return pathToFileURL(join(getRecordingsDir(), meeting.recordingPath)).href
  })
}
