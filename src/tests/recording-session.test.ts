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
    getMeeting: vi.fn(() => null),
    updateMeeting: vi.fn(),
    createMeeting: vi.fn(),
    findMeetingByCalendarEventId: vi.fn(() => null),
    shouldSyncAttendees: vi.fn(() => false),
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
// user.repo is hit by deriveSelfNameFromUserId in the ad-hoc create path —
// stub it so the lifecycle-driving spy test doesn't touch the real SQLite DB.
vi.mock('@cyggie/db/sqlite/repositories/user.repo', () => ({
  getUser: () => ({ displayName: 'Test User', firstName: 'Test', lastName: 'User', email: 'test@example.com' }),
}))

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
  correctProperNouns: vi.fn((line: string, _names: string[]) => line),
}))
// Spy on the markdown-level wrapper so the proper-noun wire-through can be
// asserted at a stable boundary (called once per finalize with the full
// crmNames array — independent of how many body lines the transcript has).
vi.mock('@cyggie/services/recording/normalize-segments', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    correctTranscriptMarkdown: vi.fn((md: string, _names: string[]) => md),
  }
})
vi.mock('@main/utils/company-extractor', () => ({ extractCompaniesFromEmails: () => [] }))

// Deepgram + audio mocks — instantiated by start(), so we mock the
// constructors to expose minimal stubs.
vi.mock('@main/deepgram/client', () => ({
  DeepgramStreamingClient: vi.fn().mockImplementation(() => ({
    provider: 'deepgram',
    connect: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn(),
    finalizeAndClose: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
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

describe('RecordingSession — proper-noun correction wire-through', () => {
  it('passes meeting.selfName + meeting.attendees into the corrector (ad-hoc path)', async () => {
    // Calendar is mocked to return null at the top of the file, so this
    // exercises the ad-hoc create path — snapshot.calendarSelfName is null
    // throughout. The protection comes from meeting.selfName (populated at
    // create time via deriveSelfNameFromUserId fallback) and meeting.attendees
    // (read back from the DB inside runBackgroundFinalize). Asserting the
    // captured crmNames here locks in Part 2 of the Sandy/Andy fix.
    const meetingRepo = await import('@cyggie/db/sqlite/repositories/meeting.repo')
    const { correctTranscriptMarkdown } = await import(
      '@cyggie/services/recording/normalize-segments'
    )

    const fakeMeeting = {
      id: 'meeting-spy-1',
      title: 'Test Meeting',
      date: new Date().toISOString(),
      selfName: 'Sandy Cass',
      attendees: ['Andy Doe'],
    } as unknown as ReturnType<typeof meetingRepo.getMeeting>

    vi.mocked(meetingRepo.createMeeting).mockReturnValue(fakeMeeting!)
    vi.mocked(meetingRepo.getMeeting).mockReturnValue(fakeMeeting)
    vi.mocked(correctTranscriptMarkdown).mockClear()

    const cb = makeCallbacks()
    const session = new RecordingSession(cb)
    await session.start({ title: 'Test Meeting' })

    const stopResult = session.stop()
    await stopResult.finalizePromise

    expect(correctTranscriptMarkdown).toHaveBeenCalled()
    const capturedNames = vi.mocked(correctTranscriptMarkdown).mock.calls[0]?.[1] ?? []
    expect(capturedNames).toContain('Sandy Cass')
    expect(capturedNames).toContain('Andy Doe')
  })
})
