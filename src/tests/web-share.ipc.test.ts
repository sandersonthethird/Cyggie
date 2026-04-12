/**
 * Tests for the WEB_SHARE_CREATE IPC handler in web-share.ipc.ts.
 *
 * Mock boundaries:
 *   - electron ipcMain       → captured via ipcMain.handle mock
 *   - meetingRepo.getMeeting → controlled meeting responses
 *   - getCredential          → fixed Claude API key
 *   - readTranscript         → fixed transcript string
 *   - readSummary            → controlled (null or string)
 *   - recoverSummaryFromCompanionNote → controlled recovery mock
 *   - global fetch           → controlled API responses
 *
 * Coverage:
 *   summary from file:   summaryPath set → readSummary returns content → sent in payload
 *   recovery path:       summaryPath null, status='summarized', recovery returns content → sent
 *   no recovery:         summaryPath null, status='summarized', recovery returns null → summary:null sent
 *   no transcript:       transcriptPath null → returns no_transcript error
 *   no api key:          getCredential null → returns no_api_key error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks ---

const handleMock = vi.fn()
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
}))

const getMeetingMock = vi.fn()
vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: getMeetingMock,
}))

vi.mock('../main/database/repositories/notes.repo', () => ({
  getNote: vi.fn(),
}))

const getCredentialMock = vi.fn()
vi.mock('../main/security/credentials', () => ({
  getCredential: getCredentialMock,
}))

const readTranscriptMock = vi.fn()
const readSummaryMock = vi.fn()
vi.mock('../main/storage/file-manager', () => ({
  readTranscript: readTranscriptMock,
  readSummary: readSummaryMock,
}))

const recoverMock = vi.fn()
vi.mock('../main/services/meeting-summary-recovery', () => ({
  recoverSummaryFromCompanionNote: recoverMock,
}))

vi.mock('../main/config/web-share.config', () => ({
  WEB_SHARE_API_URL: 'https://cyggie.vercel.app',
  WEB_SHARE_API_SECRET: 'test-secret',
}))

// --- Import after mocks ---

const { registerWebShareHandlers } = await import('../main/ipc/web-share.ipc')
const { IPC_CHANNELS } = await import('../shared/constants/channels')

registerWebShareHandlers()

type MeetingHandlerFn = (_event: unknown, meetingId: string) => Promise<unknown>
let capturedMeetingShareHandler: MeetingHandlerFn | null = null
for (const call of handleMock.mock.calls) {
  if (call[0] === IPC_CHANNELS.WEB_SHARE_CREATE) {
    capturedMeetingShareHandler = call[1] as MeetingHandlerFn
    break
  }
}

// --- Base fixtures ---

const BASE_MEETING = {
  id: 'meeting-1',
  title: 'Acme Q1 Review',
  date: '2026-04-09T13:00:00Z',
  durationSeconds: 1980,
  transcriptPath: 'transcript.txt',
  summaryPath: null as string | null,
  notes: null,
  speakerMap: {},
  attendees: null,
  status: 'summarized',
}

const TRANSCRIPT = 'Speaker 0: Hello.\nSpeaker 1: Hi.'
const SUMMARY = '## Summary\n\nStrong quarter.'
const API_KEY = 'sk-ant-test'

// --- Tests ---

describe('WEB_SHARE_CREATE IPC handler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getMeetingMock.mockReturnValue(BASE_MEETING)
    getCredentialMock.mockReturnValue(API_KEY)
    readTranscriptMock.mockReturnValue(TRANSCRIPT)
    readSummaryMock.mockReturnValue(null)
    recoverMock.mockReturnValue(null)
  })

  it('registers the WEB_SHARE_CREATE handler', () => {
    expect(capturedMeetingShareHandler).not.toBeNull()
  })

  it('includes summary from file in POST body when summaryPath is set', async () => {
    getMeetingMock.mockReturnValue({ ...BASE_MEETING, summaryPath: 'summary.md' })
    readSummaryMock.mockReturnValue(SUMMARY)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'tok1', url: 'https://cyggie.vercel.app/s/tok1' }),
    } as Response)

    await capturedMeetingShareHandler!(null, 'meeting-1')

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.summary).toBe(SUMMARY)
    expect(recoverMock).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('calls recovery and includes summary when summaryPath is null and status is summarized', async () => {
    recoverMock.mockReturnValue(SUMMARY)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'tok2', url: 'https://cyggie.vercel.app/s/tok2' }),
    } as Response)

    await capturedMeetingShareHandler!(null, 'meeting-1')

    expect(recoverMock).toHaveBeenCalledWith(BASE_MEETING)
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.summary).toBe(SUMMARY)
    fetchSpy.mockRestore()
  })

  it('sends summary:null when summaryPath is null and recovery returns null', async () => {
    recoverMock.mockReturnValue(null)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'tok3', url: 'https://cyggie.vercel.app/s/tok3' }),
    } as Response)

    await capturedMeetingShareHandler!(null, 'meeting-1')

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.summary).toBeNull()
    fetchSpy.mockRestore()
  })

  it('returns no_transcript error when transcriptPath is null', async () => {
    getMeetingMock.mockReturnValue({ ...BASE_MEETING, transcriptPath: null })

    const result = await capturedMeetingShareHandler!(null, 'meeting-1') as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('no_transcript')
  })

  it('returns no_api_key error when Claude key is not set', async () => {
    getCredentialMock.mockReturnValue(null)

    const result = await capturedMeetingShareHandler!(null, 'meeting-1') as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('no_api_key')
  })
})
