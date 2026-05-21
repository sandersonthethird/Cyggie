// Unit tests for the session module:
//
//   1. performUpload's success / failure paths — exercised through the
//      `retryPendingUpload` entrypoint (audio-retention regression).
//   2. stopRecording state transitions — regression: the Stop button
//      must flip the store into 'uploading' so the UI updates, and a
//      stopAndUnloadAsync throw must surface via markError.
//   3. cancelRecording — must always reset the store, even when no
//      recording was active (Cancel-after-Stop edge case).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Recording lifecycle state (controlled per-test via the mock below) ─────

let stopAndUnloadShouldThrow: Error | null = null
let recordingUri: string | null = 'file:///recording.m4a'

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

// expo-av: stub the recording lifecycle. createAsync returns a fake recording
// whose stopAndUnloadAsync resolves by default, or throws if the test sets
// stopAndUnloadShouldThrow. getURI returns whatever recordingUri is set to
// (default a fake m4a path; null exercises the "no audio file" branch).
vi.mock('expo-av', () => ({
  Audio: {
    Recording: {
      createAsync: async () => ({
        recording: {
          stopAndUnloadAsync: async () => {
            if (stopAndUnloadShouldThrow) throw stopAndUnloadShouldThrow
          },
          getURI: () => recordingUri,
        },
      }),
    },
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
      beginRecording: () => storeCalls.push({ method: 'beginRecording' }),
      reset: () => storeCalls.push({ method: 'reset' }),
    }),
  },
}))

const { retryPendingUpload, startRecording, stopRecording, cancelRecording } =
  await import('../session')

beforeEach(() => {
  mmkvStore.clear()
  fileSystemDeleteCalls.length = 0
  storeCalls.length = 0
  uploadShouldThrow = null
  uploadShouldReturn = { meetingId: 'mtg-test' }
  fileExistsResponse = true
  stopAndUnloadShouldThrow = null
  recordingUri = 'file:///recording.m4a'
})
afterEach(async () => {
  mmkvStore.clear()
  // Best-effort reset of the module-level activeRecording so tests that
  // throw mid-flow don't leak state into the next test.
  try {
    await cancelRecording()
  } catch {
    // ignore
  }
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
    // beginUploading must precede finalizeMeeting — locks in that
    // performUpload owns the 'uploading' → 'transcribing' transition.
    const order = storeCalls.map((c) => c.method)
    expect(order.indexOf('beginUploading')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('beginUploading')).toBeLessThan(
      order.indexOf('finalizeMeeting'),
    )
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

describe('stopRecording — state transitions', () => {
  it('calls beginUploading before finalizeMeeting (regression: stop button silent)', async () => {
    // Reproduces the user-reported bug: tap Stop, store stays in
    // 'recording' because beginUploading is never invoked, UI looks frozen.
    // The fix moved beginUploading() into performUpload() so this codepath
    // can't regress without breaking retryPendingUpload tests too.
    uploadShouldReturn = { meetingId: 'mtg-stop' }
    await startRecording()
    await stopRecording({})
    const order = storeCalls.map((c) => c.method)
    const beginIdx = order.indexOf('beginUploading')
    const finalizeIdx = order.indexOf('finalizeMeeting')
    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(finalizeIdx).toBeGreaterThan(beginIdx)
  })

  it('flips store to error via markError when stopAndUnloadAsync throws', async () => {
    // expo-av can reject mid-stop (audio session interruption, file lock).
    // The old code let the error propagate to onStop's console.warn while
    // leaving the store at 'recording', producing the same silent-stuck UI
    // as the original bug.
    stopAndUnloadShouldThrow = new Error('audio session interrupted')
    await startRecording()
    await expect(stopRecording({})).rejects.toThrow('audio session interrupted')
    const markErr = storeCalls.find((c) => c.method === 'markError')
    expect(markErr?.arg).toBe('audio session interrupted')
    // beginUploading must NOT have fired — we never got past stop.
    expect(storeCalls.find((c) => c.method === 'beginUploading')).toBeUndefined()
  })
})

describe('cancelRecording', () => {
  it('calls reset even when no active recording (Cancel-after-Stop edge case)', async () => {
    // Without this, hitting Cancel from an already-stopped state leaves the
    // store in 'uploading'/'transcribing', so the next /record mount renders
    // a stale in-flight UI instead of starting fresh.
    await cancelRecording()
    expect(storeCalls.find((c) => c.method === 'reset')).toBeDefined()
  })

  it('calls reset after stopping an active recording', async () => {
    await startRecording()
    await cancelRecording()
    expect(storeCalls.find((c) => c.method === 'reset')).toBeDefined()
  })
})
