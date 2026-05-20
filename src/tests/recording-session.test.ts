/**
 * Unit tests for the RecordingSession class — focused on the public surface
 * the IPC adapter relies on (isActive accessor, meetingId accessor, terminal
 * state after stop, pause/resume no-ops when not started, missing-credential
 * error path).
 *
 * The happy-path lifecycle (start → record → stop → finalize) is covered
 * end-to-end by recording-stop-defer.test.ts via the IPC handler; this file
 * doesn't re-test that.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// _sync.ts pass-through so barrel index.ts loads without
// configureSyncGlobals (which only runs in production bootstrap).
vi.mock('@cyggie/db/sqlite/repositories/_sync', () => ({
  withSync: (fn: unknown) => fn,
  configureSyncGlobals: () => {},
}))

// Barrel + raw repo modules — pass-throughs with explicit overrides for
// the names the class touches. Same pattern as recording-stop-defer.
vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getMeeting: () => null,
    updateMeeting: vi.fn(),
    createMeeting: vi.fn(),
    findMeetingByCalendarEventId: () => null,
    shouldSyncAttendees: () => false,
  }
})
vi.mock('@cyggie/db/sqlite/repositories/contact.repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, listContactsLight: () => [], syncContactsFromAttendees: vi.fn() }
})
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, listCompanies: () => [], repairContactCompanyMismatches: vi.fn() }
})
vi.mock('@cyggie/db/sqlite/repositories/settings.repo', () => ({ getSetting: () => null }))
vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({ logAudit: vi.fn() }))
vi.mock('@cyggie/db/sqlite/repositories/search.repo', () => ({ indexMeeting: vi.fn() }))

// Electron not used by the class itself, but transitive imports pull it in.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
  app: { getPath: () => '/tmp' },
}))

// Per-test control of the deepgram credential.
const getCredentialMock = vi.fn<(k: string) => string | null>()
vi.mock('@main/security/credentials', () => ({
  getCredential: (key: string) => getCredentialMock(key),
}))
vi.mock('@main/security/current-user', () => ({
  getCurrentUserId: () => 'test-user',
  getCurrentUserProfile: () => ({ email: 'sandy@example.com' }),
}))

// Calendar / drive / file-system mocks — minimum to satisfy imports.
vi.mock('@main/calendar/google-calendar', () => ({
  getCurrentMeetingEvent: () => null,
  getEventById: () => null,
}))
vi.mock('@main/calendar/google-auth', () => ({
  isCalendarConnected: () => false,
  hasDriveScope: () => false,
}))
vi.mock('@main/drive/google-drive', () => ({
  uploadTranscript: vi.fn().mockResolvedValue({ driveId: 'fake' }),
}))
vi.mock('@main/storage/file-manager', () => ({ writeTranscript: () => 'fake.md' }))
vi.mock('@main/storage/paths', () => ({ getTranscriptsDir: () => '/tmp' }))
vi.mock('@main/utils/proper-noun-corrector', () => ({
  correctProperNouns: (line: string) => line,
}))
vi.mock('@main/utils/company-extractor', () => ({ extractCompaniesFromEmails: () => [] }))

// Deepgram + audio mocks — instantiated by start(), so we mock the
// constructors to expose minimal stubs.
vi.mock('@main/deepgram/client', () => ({
  DeepgramStreamingClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn(),
    finalizeAndClose: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  })),
}))
vi.mock('@main/deepgram/transcript-assembler', () => ({
  TranscriptAssembler: vi.fn().mockImplementation(() => ({
    addResult: vi.fn(),
    handleResult: vi.fn(),
    finalize: vi.fn(),
    correctSpeakerBoundaries: vi.fn(),
    consolidateSpeakers: vi.fn(),
    getFinalizedSpeakerIds: () => new Set<number>(),
    getInterimSegment: () => null,
    getFinalizedSegments: () => [],
    getSpeakerCount: () => 0,
    getChannelMode: () => 'multichannel',
    toMarkdown: () => '',
    getSerializableState: () => [],
    getFullText: () => '',
    getDiagnostics: () => ({
      channelMode: 'multichannel',
      speakerCount: 0,
      totalSegments: 0,
      totalSuppressedSwitches: 0,
    }),
    setExpectedSpeakerCount: vi.fn(),
    setKeyterms: vi.fn(),
    restoreSegments: vi.fn(),
    setSystemAudioUnavailable: vi.fn(),
  })),
}))
vi.mock('@main/audio/capture', () => ({
  AudioCapture: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    feedAudioFromRenderer: vi.fn(),
    on: vi.fn(),
  })),
}))
vi.mock('@main/audio/stream-manager', () => ({
  AudioStreamManager: { stereoToMono: (b: Buffer) => b },
}))
vi.mock('@main/recording/auto-stop', () => ({
  RecordingAutoStop: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    onSpeechDetected: vi.fn(),
  })),
}))

const { RecordingSession } = await import('@cyggie/services/recording/RecordingSession')

function makeCallbacks() {
  return {
    onTranscriptUpdate: vi.fn(),
    onStatus: vi.fn(),
    onError: vi.fn(),
    onAutoStop: vi.fn(),
    onFinalized: vi.fn(),
    onFinalizeError: vi.fn(),
  }
}

beforeEach(() => {
  getCredentialMock.mockReset()
  getCredentialMock.mockReturnValue('fake-deepgram-key')
})

describe('RecordingSession — pre-start state', () => {
  it('starts inactive with null meetingId', () => {
    const session = new RecordingSession(makeCallbacks())
    expect(session.isActive).toBe(false)
    expect(session.meetingId).toBeNull()
  })

  it('pause() is a no-op when not started', () => {
    const cb = makeCallbacks()
    const session = new RecordingSession(cb)
    session.pause()
    expect(cb.onStatus).not.toHaveBeenCalled()
    expect(session.isActive).toBe(false)
  })

  it('resume() is a no-op when not started', () => {
    const cb = makeCallbacks()
    const session = new RecordingSession(cb)
    session.resume()
    expect(cb.onStatus).not.toHaveBeenCalled()
  })

  it('feedAudio() is a no-op when not started', () => {
    const session = new RecordingSession(makeCallbacks())
    expect(() => session.feedAudio(Buffer.from('x'))).not.toThrow()
  })

  it('stop() throws when not started', () => {
    const session = new RecordingSession(makeCallbacks())
    expect(() => session.stop()).toThrow('Not recording')
  })
})

describe('RecordingSession — start error paths', () => {
  it('start() throws when deepgram credential is missing', async () => {
    getCredentialMock.mockReturnValue(null)
    const session = new RecordingSession(makeCallbacks())
    await expect(session.start({ title: 'Test' })).rejects.toThrow(
      /Deepgram API key not configured/,
    )
    // Failed start leaves the session in idle — caller can discard or retry.
    expect(session.isActive).toBe(false)
  })

  it('start() throws "Meeting not found" when appendToMeetingId points to nothing', async () => {
    const session = new RecordingSession(makeCallbacks())
    await expect(session.start({ appendToMeetingId: 'does-not-exist' })).rejects.toThrow(
      'Meeting not found',
    )
    expect(session.isActive).toBe(false)
  })
})

// Terminal state (started → stopped → cannot restart) is covered
// end-to-end by recording-stop-defer's "after STOP returns, calling STOP
// again throws" assertion, which exercises the full DB+deepgram pipeline.
// We don't duplicate that here.
