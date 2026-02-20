import { desktopCapturer, ipcMain, session } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import {
  startVideoFile,
  appendVideoChunk,
  finalizeVideoFile
} from '../video/video-writer'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { buildRecordingFilename } from '../storage/file-manager'
import type { MeetingPlatform } from '../../shared/constants/meeting-apps'

const BROWSER_NAMES = ['google chrome', 'chrome', 'safari', 'microsoft edge', 'arc', 'firefox', 'brave browser', 'chromium']

function findMeetingWindow(
  sources: Electron.DesktopCapturerSource[],
  platform: MeetingPlatform
): Electron.DesktopCapturerSource | null {
  if (platform === 'zoom') {
    const matches = sources.filter((s) => s.name.toLowerCase().includes('zoom'))
    // Prefer the active meeting window over ancillary windows
    return (
      matches.find((s) => s.name.includes('Zoom Meeting') || s.name.includes('Zoom Workplace')) ||
      matches[0] ||
      null
    )
  }

  if (platform === 'teams') {
    const matches = sources.filter((s) => s.name.toLowerCase().includes('teams'))
    // Prefer a call/meeting window over the main hub
    return (
      matches.find((s) => !s.name.startsWith('Microsoft Teams') || matches.length === 1) ||
      matches[0] ||
      null
    )
  }

  if (platform === 'google_meet') {
    // Google Meet runs in a browser tab — look for "Google Meet" in the window title
    const matches = sources.filter((s) => {
      const name = s.name.toLowerCase()
      return name.includes('google meet') || name.includes('meet.google.com')
    })
    return matches.find((s) => s.name.includes('Google Meet')) || matches[0] || null
  }

  return null
}

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
    return `media://recordings/${encodeURIComponent(meeting.recordingPath)}`
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
