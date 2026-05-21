// Unit tests for performUpload's success path: it must NOT delete the local
// audio file and MUST stamp the MMKV entry with the server-assigned
// meetingId. This is the regression test that closes critical failure
// mode #① from the plan review (silent-loss of audio if a future refactor
// re-introduces the delete).
//
// performUpload itself is module-internal, so we drive it through the
// public `retryPendingUpload` entrypoint (which is the simpler harness —
// no need to mock the expo-av recording lifecycle that `stopRecording`
// requires).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────

// In-memory MMKV double
const mmkvStore = new Map<string, string>()
vi.mock('../../cache/mmkv', () => ({
  appStateStorage: {
    set: (k: string, v: string) => {
      mmkvStore.set(k, v)
    },
    getString: (k: string) => mmkvStore.get(k),
    delete: (k: string) => {
      mmkvStore.delete(k)
    },
  },
}))

// Filesystem: record deleteAsync calls, default getInfoAsync to "exists"
const fileSystemDeleteCalls: string[] = []
let fileExistsResponse = true
vi.mock('expo-file-system/legacy', () => ({
  deleteAsync: async (uri: string) => {
    fileSystemDeleteCalls.push(uri)
  },
  getInfoAsync: async (_uri: string) => ({
    exists: fileExistsResponse,
    size: 1024,
  }),
}))

// expo-av is imported at the top of session.ts. We don't exercise the
// Recording APIs in this test, but the import has to resolve cleanly.
vi.mock('expo-av', () => ({
  Audio: {
    Recording: class {},
    setAudioModeAsync: async () => {},
    requestPermissionsAsync: async () => ({ granted: true }),
    AndroidOutputFormat: { MPEG_4: 2 },
    AndroidAudioEncoder: { AAC: 3 },
    IOSOutputFormat: { MPEG4AAC: 0 },
    IOSAudioQuality: { MEDIUM: 64 },
  },
}))

// uploadRecording: success by default; tweak via setUploadResult
let uploadShouldThrow: Error | null = null
let uploadShouldReturn: { meetingId: string } = { meetingId: 'mtg-default' }
vi.mock('../../api/recordings', () => ({
  uploadRecording: async (_args: unknown) => {
    if (uploadShouldThrow) throw uploadShouldThrow
    return uploadShouldReturn
  },
}))

// Recording store: capture the state transitions we care about
const storeCalls: Array<{ method: string; arg?: unknown }> = []
vi.mock('../store', () => ({
  useRecordingStore: {
    getState: () => ({
      setUploadProgress: (p: number) => storeCalls.push({ method: 'setUploadProgress', arg: p }),
      finalizeMeeting: (id: string) => storeCalls.push({ method: 'finalizeMeeting', arg: id }),
      markError: (m: string) => storeCalls.push({ method: 'markError', arg: m }),
      beginUploading: () => storeCalls.push({ method: 'beginUploading' }),
    }),
  },
}))

const { retryPendingUpload } = await import('../session')

beforeEach(() => {
  mmkvStore.clear()
  fileSystemDeleteCalls.length = 0
  storeCalls.length = 0
  uploadShouldThrow = null
  uploadShouldReturn = { meetingId: 'mtg-test' }
  fileExistsResponse = true
})
afterEach(() => {
  mmkvStore.clear()
})

describe('performUpload — success path (via retryPendingUpload)', () => {
  it('does NOT call FileSystem.deleteAsync on success', async () => {
    await retryPendingUpload({
      localUri: 'file:///a.m4a',
      clientRecordedAt: new Date().toISOString(),
    })
    // Critical regression assertion — closes failure-mode #① from the plan
    // review. Audio file must outlive a successful upload until the
    // transcribed/empty status arrives via the poll.
    expect(fileSystemDeleteCalls).toEqual([])
  })

  it('saves the pending entry with meetingId set + clears lastError', async () => {
    uploadShouldReturn = { meetingId: 'mtg-1234' }
    await retryPendingUpload({
      localUri: 'file:///a.m4a',
      clientRecordedAt: new Date().toISOString(),
      lastError: 'previous attempt failed',
    })
    const stored = JSON.parse(mmkvStore.get('cyggie.pending-upload.v1') ?? '{}')
    expect(stored.meetingId).toBe('mtg-1234')
    expect(stored.lastError).toBeUndefined()
    expect(stored.localUri).toBe('file:///a.m4a')
  })

  it('flips store to transcribing via finalizeMeeting before persisting MMKV', async () => {
    uploadShouldReturn = { meetingId: 'mtg-abc' }
    await retryPendingUpload({
      localUri: 'file:///a.m4a',
      clientRecordedAt: new Date().toISOString(),
    })
    const finalize = storeCalls.find((c) => c.method === 'finalizeMeeting')
    expect(finalize?.arg).toBe('mtg-abc')
  })
})

describe('performUpload — failure path (via retryPendingUpload)', () => {
  it('saves pending entry with lastError + meetingId undefined on upload throw', async () => {
    uploadShouldThrow = new Error('Upload failed (502)')
    await expect(
      retryPendingUpload({
        localUri: 'file:///b.m4a',
        clientRecordedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('Upload failed (502)')
    const stored = JSON.parse(mmkvStore.get('cyggie.pending-upload.v1') ?? '{}')
    expect(stored.lastError).toBe('Upload failed (502)')
    expect(stored.meetingId).toBeUndefined()
    // File must also not be deleted on failure — same audio is the basis
    // for the user's retry attempt.
    expect(fileSystemDeleteCalls).toEqual([])
  })

  it('aborts with a clear error when the local file is gone before retry', async () => {
    fileExistsResponse = false
    await expect(
      retryPendingUpload({
        localUri: 'file:///gone.m4a',
        clientRecordedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('Local audio file missing')
    // MMKV cleared so the user isn't stuck with an un-retryable entry
    expect(mmkvStore.get('cyggie.pending-upload.v1')).toBeUndefined()
  })
})
