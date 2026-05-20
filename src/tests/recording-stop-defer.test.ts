/**
 * Verifies the return-then-finalize behavior of the RECORDING_STOP IPC handler.
 *
 * Same pattern as video-stop-defer.test.ts; minimal precise mocks.
 *
 * The handler should:
 *   1. Return to the renderer in ~ms (not seconds)
 *   2. Reset module state synchronously so a new RECORDING_START can fire
 *   3. Run Deepgram finalize + transcript pipeline in the background
 *   4. On success: broadcast RECORDING_FINALIZED + write DB
 *   5. On failure: broadcast RECORDING_FINALIZE_ERROR + best-effort
 *      meetingRepo.updateMeeting({status:'error'})
 *   6. Track / clean the in-flight promise in the shared finalizations map
 *   7. RECORDING_START for the same meetingId awaits the pending finalize
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC_CHANNELS } from '../shared/constants/channels'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const broadcasts: Array<{ channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    on: vi.fn(), // recording.ipc.ts uses ipcMain.on for system-audio-status
  },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => broadcasts.push({ channel, payload }),
      },
    }],
  },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}))

// Deepgram client mock — finalizeAndClose is the timing-critical await.
const mockFinalizeAndClose = vi.fn()
const mockDeepgramClose = vi.fn().mockResolvedValue(undefined)
const mockDeepgramSendAudio = vi.fn()
const mockDeepgramOn = vi.fn()
const mockDeepgramConnect = vi.fn().mockResolvedValue(undefined)
vi.mock('../main/deepgram/client', () => ({
  DeepgramStreamingClient: vi.fn().mockImplementation(() => ({
    connect: mockDeepgramConnect,
    sendAudio: mockDeepgramSendAudio,
    finalizeAndClose: mockFinalizeAndClose,
    close: mockDeepgramClose,
    on: mockDeepgramOn,
  })),
}))

// Transcript assembler — methods invoked from the background IIFE.
const mockTranscriptFinalize = vi.fn()
const mockTranscriptCorrect = vi.fn()
const mockTranscriptGetDiagnostics = vi.fn(() => ({
  channelMode: 'multichannel', speakerCount: 1, totalSegments: 1, totalSuppressedSwitches: 0,
}))
const mockTranscriptConsolidate = vi.fn()
const mockTranscriptGetSpeakerIds = vi.fn(() => new Set<number>([0]))
const mockTranscriptGetChannelMode = vi.fn(() => 'multichannel')
const mockTranscriptToMarkdown = vi.fn(() => '**Speaker 1** [00:00] hello\n')
const mockTranscriptGetSerializableState = vi.fn(() => [])
const mockTranscriptGetFullText = vi.fn(() => 'hello')
const mockTranscriptHandle = vi.fn()
vi.mock('../main/deepgram/transcript-assembler', () => ({
  TranscriptAssembler: vi.fn().mockImplementation(() => ({
    handleResult: mockTranscriptHandle,
    finalize: mockTranscriptFinalize,
    correctSpeakerBoundaries: mockTranscriptCorrect,
    consolidateSpeakers: mockTranscriptConsolidate,
    getFinalizedSpeakerIds: mockTranscriptGetSpeakerIds,
    getChannelMode: mockTranscriptGetChannelMode,
    toMarkdown: mockTranscriptToMarkdown,
    getSerializableState: mockTranscriptGetSerializableState,
    getFullText: mockTranscriptGetFullText,
    getDiagnostics: mockTranscriptGetDiagnostics,
    setExpectedSpeakerCount: vi.fn(),
    setKeyterms: vi.fn(),
  })),
}))

// Audio capture + stream manager + auto-stop — instantiated by RECORDING_START.
vi.mock('../main/audio/capture', () => ({
  AudioCapture: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    feedAudioFromRenderer: vi.fn(),
    on: vi.fn(),
  })),
}))
vi.mock('../main/audio/stream-manager', () => ({
  AudioStreamManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}))
vi.mock('../main/recording/auto-stop', () => ({
  RecordingAutoStop: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}))

// Repo / storage / search / drive / audit — minimal stubs.
const mockGetMeeting = vi.fn()
const mockUpdateMeeting = vi.fn()
const mockCreateMeeting = vi.fn()
// The barrel index.ts wraps owned-table writes in withSync(), which throws
// unless configureSyncGlobals() has been called at bootstrap. For unit tests
// we make withSync a pass-through so the underlying mocked repo functions
// (mockGetMeeting / mockUpdateMeeting / mockCreateMeeting) are observed
// directly. Same pattern as contact-tombstones.test.ts.
vi.mock('@cyggie/db/sqlite/repositories/_sync', () => ({
  withSync: (fn: unknown) => fn,
  configureSyncGlobals: () => {},
}))

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', async (importOriginal) => {
  // Forward all real exports so the barrel index.ts can wrap deleteMeeting,
  // getMeetingSpeakerContactMap, listMeetings, etc. at evaluation time —
  // then override the three the test needs to observe.
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getMeeting: (...args: unknown[]) => mockGetMeeting(...args),
    updateMeeting: (...args: unknown[]) => mockUpdateMeeting(...args),
    createMeeting: (...args: unknown[]) => mockCreateMeeting(...args),
    findMeetingByCalendarEventId: () => null,
    // Bypass the contact-sync branch in RecordingSession.start — the real
    // function hits SQLite; tests just need the if-check to short-circuit.
    shouldSyncAttendees: () => false,
  }
})
vi.mock('../main/storage/file-manager', () => ({
  writeTranscript: () => 'fake-transcript.md',
}))
vi.mock('../main/storage/paths', () => ({
  getTranscriptsDir: () => '/tmp',
}))
vi.mock('@cyggie/db/sqlite/repositories/search.repo', () => ({
  indexMeeting: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({
  logAudit: vi.fn(),
}))
vi.mock('@cyggie/db/sqlite/repositories/contact.repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listContactsLight: () => [],
    syncContactsFromAttendees: vi.fn(),
  }
})
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    listCompanies: () => [],
    // Barrel index.ts references rawOrgCompany.repairContactCompanyMismatches
    // but the real repo doesn't export it (pre-existing barrel-side typo).
    // Stub here so the mock spread covers what the barrel reads at eval time.
    repairContactCompanyMismatches: vi.fn(),
  }
})
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({
  getSetting: () => null,
}))
vi.mock('../main/utils/proper-noun-corrector', () => ({
  correctProperNouns: (line: string) => line,
}))
vi.mock('../main/security/credentials', () => ({
  getCredential: () => 'fake-deepgram-key',
}))
vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'user-1',
  getCurrentUserProfile: () => ({ email: 'sandy@example.com' }),
}))
vi.mock('../main/calendar/google-calendar', () => ({
  getCurrentMeetingEvent: () => null,
  getEventById: () => null,
}))
vi.mock('../main/calendar/google-auth', () => ({
  isCalendarConnected: () => false,
  hasDriveScope: () => false,
}))
vi.mock('../main/drive/google-drive', () => ({
  uploadTranscript: vi.fn().mockResolvedValue({ driveId: 'fake' }),
}))
vi.mock('../main/tray', () => ({
  updateTrayMenu: vi.fn(),
}))
vi.mock('../main/utils/company-extractor', () => ({
  extractCompaniesFromEmails: () => [],
}))

const { registerRecordingHandlers } = await import('../main/ipc/recording.ipc')
const { hasPending, getPending, _resetForTests } = await import('../main/ipc/_finalizations')

beforeEach(() => {
  handlers.clear()
  broadcasts.length = 0
  mockFinalizeAndClose.mockReset()
  mockUpdateMeeting.mockReset()
  mockCreateMeeting.mockReset()
  mockGetMeeting.mockReset()
  mockGetMeeting.mockReturnValue({
    id: 'mtg-1', title: 'Test', date: '2026-05-15T12:00:00Z',
    attendees: [], attendeeEmails: [], status: 'recording',
  })
  mockCreateMeeting.mockImplementation((data: { title?: string }) => ({
    id: 'mtg-1', title: data.title ?? 'Test', date: '2026-05-15T12:00:00Z',
    attendees: [], attendeeEmails: [], status: 'recording', meetingPlatform: null,
  }))
  _resetForTests()
  registerRecordingHandlers()
})

afterEach(() => {
  vi.useRealTimers()
})

function getHandler(channel: string): Handler {
  const h = handlers.get(channel)
  if (!h) throw new Error(`${channel} not registered`)
  return h
}

async function startRecording(): Promise<void> {
  await (getHandler(IPC_CHANNELS.RECORDING_START) as (...args: unknown[]) => Promise<unknown>)(null, 'Test')
}

describe('RECORDING_STOP — return then finalize', () => {
  it('returns within 50ms even when Deepgram finalize takes seconds', async () => {
    await startRecording()
    let resolveFinalize: () => void = () => {}
    mockFinalizeAndClose.mockImplementation(() => new Promise<void>((res) => { resolveFinalize = res }))

    const start = performance.now()
    const result = await (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(50)
    expect(result).toMatchObject({ meetingId: 'mtg-1' })
    expect(hasPending('recording', 'mtg-1')).toBe(true)
    expect(mockUpdateMeeting).not.toHaveBeenCalled()

    resolveFinalize()
    await getPending('recording', 'mtg-1')

    expect(mockUpdateMeeting).toHaveBeenCalledWith('mtg-1', expect.objectContaining({
      status: 'transcribed',
      transcriptPath: 'fake-transcript.md',
    }), 'user-1')
    expect(broadcasts.filter((b) => b.channel === IPC_CHANNELS.RECORDING_FINALIZED)).toHaveLength(1)
    expect(hasPending('recording', 'mtg-1')).toBe(false)
  })

  it('after STOP returns, calling STOP again throws "Not recording" (module state reset)', async () => {
    await startRecording()
    let resolveFinalize: () => void = () => {}
    mockFinalizeAndClose.mockImplementation(() => new Promise<void>((res) => { resolveFinalize = res }))

    await (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    await expect(
      (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    ).rejects.toThrow('Not recording')

    resolveFinalize()
    await getPending('recording', 'mtg-1')
  })

  it('on finalize failure: broadcasts RECORDING_FINALIZE_ERROR and best-effort sets status=error', async () => {
    await startRecording()
    let rejectFinalize: (err: Error) => void = () => {}
    mockFinalizeAndClose.mockImplementation(() => new Promise<void>((_, rej) => { rejectFinalize = rej }))

    await (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    // Make the assembler.finalize throw to simulate transcript pipeline failure.
    // Easier: reject the deepgram finalize then have close also throw.
    mockDeepgramClose.mockRejectedValueOnce(new Error('forced close also failed'))
    mockTranscriptFinalize.mockImplementationOnce(() => { throw new Error('transcript explode') })
    rejectFinalize(new Error('deepgram exploded'))

    await getPending('recording', 'mtg-1')

    expect(broadcasts.filter((b) => b.channel === IPC_CHANNELS.RECORDING_FINALIZE_ERROR)).toHaveLength(1)
    expect(broadcasts.filter((b) => b.channel === IPC_CHANNELS.RECORDING_FINALIZED)).toHaveLength(0)
    expect(mockUpdateMeeting).toHaveBeenCalledWith('mtg-1', { status: 'error' }, 'user-1')
    expect(hasPending('recording', 'mtg-1')).toBe(false)
  })

  it('pendingRecording entry is added before return and removed after settlement', async () => {
    await startRecording()
    let rejectFinalize: (err: Error) => void = () => {}
    mockFinalizeAndClose.mockImplementation(() => new Promise<void>((_, rej) => { rejectFinalize = rej }))

    await (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    expect(hasPending('recording', 'mtg-1')).toBe(true)

    mockDeepgramClose.mockRejectedValueOnce(new Error('x'))
    mockTranscriptFinalize.mockImplementationOnce(() => { throw new Error('y') })
    rejectFinalize(new Error('z'))
    await getPending('recording', 'mtg-1')

    expect(hasPending('recording', 'mtg-1')).toBe(false)
  })

  it('throws synchronously when not recording', async () => {
    await expect(
      (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    ).rejects.toThrow('Not recording')
    expect(mockFinalizeAndClose).not.toHaveBeenCalled()
  })

  it('RECORDING_START for the same meeting awaits any pending finalize', async () => {
    await startRecording()
    let resolveFinalize: () => void = () => {}
    mockFinalizeAndClose.mockImplementation(() => new Promise<void>((res) => { resolveFinalize = res }))

    await (getHandler(IPC_CHANNELS.RECORDING_STOP) as (...args: unknown[]) => Promise<unknown>)(null)
    expect(hasPending('recording', 'mtg-1')).toBe(true)

    // Kick off RECORDING_START with appendToMeetingId='mtg-1' (continue case).
    // It should not resolve until we release the previous finalize.
    let startResolved = false
    const startP = (getHandler(IPC_CHANNELS.RECORDING_START) as (...args: unknown[]) => Promise<unknown>)(null, 'Test', undefined, 'mtg-1')
      .then(() => { startResolved = true })
      .catch(() => { startResolved = true })

    // Yield to event loop; start should still be pending.
    await new Promise((r) => setImmediate(r))
    expect(startResolved).toBe(false)

    resolveFinalize()
    await getPending('recording', 'mtg-1')
    await startP
    expect(startResolved).toBe(true)
  })
})
