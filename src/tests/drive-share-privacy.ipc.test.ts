/**
 * Slice 5 — DRIVE_GET_SHARE_LINK must refuse to export a PRIVATE meeting to
 * Google Drive (the last manual path a private file could leak to a shared
 * location). Public meetings still export normally.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { stubModule } from './_fixtures/mock-module'

const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}))

const getMeetingMock = vi.fn()
const updateMeetingMock = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories', () =>
  stubModule({
    getMeeting: getMeetingMock,
    updateMeeting: updateMeetingMock,
  })
)

const getShareableLinkByIdMock = vi.fn()
const uploadSummaryMock = vi.fn()
const uploadTranscriptMock = vi.fn()
vi.mock('../main/drive/google-drive', () => ({
  getShareableLinkById: getShareableLinkByIdMock,
  listDriveFolders: vi.fn(),
  uploadSummary: uploadSummaryMock,
  uploadTranscript: uploadTranscriptMock,
}))

vi.mock('../main/calendar/google-auth', () => ({
  authorizeDriveFiles: vi.fn(),
  hasDriveFilesScope: () => true,
  hasDriveScope: () => true,
  isCalendarConnected: () => true,
}))

vi.mock('../main/storage/paths', () => ({
  getSummariesDir: () => '/tmp/summaries',
  getTranscriptsDir: () => '/tmp/transcripts',
}))

const { registerDriveHandlers } = await import('../main/ipc/drive.ipc')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

registerDriveHandlers()

type ShareHandler = (_event: unknown, meetingId: string) => Promise<{ success: boolean; error?: string; message?: string; url?: string }>
let shareHandler: ShareHandler | null = null
for (const call of handleMock.mock.calls) {
  if (call[0] === IPC_CHANNELS.DRIVE_GET_SHARE_LINK) {
    shareHandler = call[1] as ShareHandler
    break
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DRIVE_GET_SHARE_LINK — privacy guard', () => {
  it('registers the handler', () => {
    expect(shareHandler).not.toBeNull()
  })

  it('refuses a PRIVATE meeting and never touches Drive', async () => {
    getMeetingMock.mockReturnValue({
      id: 'm1', isPrivate: true,
      summaryPath: 'm1.md', summaryDriveId: 'drive-abc', transcriptPath: 'm1.txt',
    })

    const res = await shareHandler!(null, 'm1')

    expect(res.success).toBe(false)
    expect(res.error).toBe('private_meeting')
    expect(res.message).toMatch(/private/i)
    // No Drive call of any kind — not even returning a pre-existing link.
    expect(getShareableLinkByIdMock).not.toHaveBeenCalled()
    expect(uploadSummaryMock).not.toHaveBeenCalled()
    expect(uploadTranscriptMock).not.toHaveBeenCalled()
  })

  it('still returns a link for a PUBLIC meeting with an existing Drive id', async () => {
    getMeetingMock.mockReturnValue({
      id: 'm2', isPrivate: false, summaryDriveId: 'drive-xyz', summaryPath: 'm2.md',
    })
    getShareableLinkByIdMock.mockResolvedValue({ success: true, url: 'https://drive/xyz' })

    const res = await shareHandler!(null, 'm2')

    expect(res).toEqual({ success: true, url: 'https://drive/xyz' })
    expect(getShareableLinkByIdMock).toHaveBeenCalledWith('drive-xyz')
  })
})
