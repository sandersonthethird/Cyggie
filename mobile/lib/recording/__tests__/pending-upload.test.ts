// Unit tests for the pendingUpload MMKV persistence + 24hr eviction helper.
//
// Runs under the root vitest config (node env) — we mock both the MMKV
// instance and expo-file-system/legacy so no native modules are required.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────
// In-memory MMKV double. Only the methods pending-upload.ts actually calls
// are implemented (set / getString / delete).
const mmkvStore = new Map<string, string>()
vi.mock('../../cache/mmkv', () => ({
  appStateStorage: {
    set: (key: string, value: string) => {
      mmkvStore.set(key, value)
    },
    getString: (key: string) => mmkvStore.get(key),
    delete: (key: string) => {
      mmkvStore.delete(key)
    },
  },
}))

// expo-file-system/legacy: track deleteAsync calls; succeed by default. We
// hide a knob behind setFileSystemFailure so the "best-effort eviction even
// when the file is gone" path is exercised.
const fileSystemCalls: Array<{ uri: string; options: unknown }> = []
let fileSystemShouldFail = false
function setFileSystemFailure(v: boolean): void {
  fileSystemShouldFail = v
}
vi.mock('expo-file-system/legacy', () => ({
  deleteAsync: async (uri: string, options: unknown) => {
    fileSystemCalls.push({ uri, options })
    if (fileSystemShouldFail) throw new Error('mock delete failure')
  },
}))

const {
  savePendingUpload,
  loadPendingUpload,
  clearPendingUpload,
  loadPendingUploadOrEvict,
} = await import('../pending-upload')

beforeEach(() => {
  mmkvStore.clear()
  fileSystemCalls.length = 0
  setFileSystemFailure(false)
})
afterEach(() => {
  mmkvStore.clear()
  fileSystemCalls.length = 0
})

describe('PendingUpload schema', () => {
  it('round-trips through save → load with optional meetingId', () => {
    const recordedAt = new Date('2026-05-21T10:00:00Z').toISOString()
    savePendingUpload({
      localUri: 'file:///audio.m4a',
      clientRecordedAt: recordedAt,
      meetingId: 'mtg-123',
    })
    const loaded = loadPendingUpload()
    expect(loaded?.localUri).toBe('file:///audio.m4a')
    expect(loaded?.meetingId).toBe('mtg-123')
    expect(loaded?.clientRecordedAt).toBe(recordedAt)
  })

  it('returns null + clears the slot when the stored blob is corrupt', () => {
    mmkvStore.set('cyggie.pending-upload.v1', '{not json at all')
    const loaded = loadPendingUpload()
    expect(loaded).toBeNull()
    expect(mmkvStore.get('cyggie.pending-upload.v1')).toBeUndefined()
  })

  it('clearPendingUpload empties the slot', () => {
    savePendingUpload({ localUri: 'file:///a.m4a', clientRecordedAt: new Date().toISOString() })
    clearPendingUpload()
    expect(loadPendingUpload()).toBeNull()
  })
})

describe('loadPendingUploadOrEvict', () => {
  it('returns the entry unchanged when within the max-age window', async () => {
    const nowMinus1Hour = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    savePendingUpload({
      localUri: 'file:///fresh.m4a',
      clientRecordedAt: nowMinus1Hour,
    })
    const out = await loadPendingUploadOrEvict()
    expect(out?.localUri).toBe('file:///fresh.m4a')
    expect(fileSystemCalls).toHaveLength(0)
    expect(mmkvStore.has('cyggie.pending-upload.v1')).toBe(true)
  })

  it('deletes file + clears MMKV when entry is older than 24hr', async () => {
    const nowMinus25Hours = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    savePendingUpload({
      localUri: 'file:///stale.m4a',
      clientRecordedAt: nowMinus25Hours,
    })
    const out = await loadPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(fileSystemCalls).toEqual([
      { uri: 'file:///stale.m4a', options: { idempotent: true } },
    ])
    expect(mmkvStore.has('cyggie.pending-upload.v1')).toBe(false)
  })

  it('still clears MMKV when the file-delete itself fails', async () => {
    // Real-world: iOS already evicted the tmp file. The defensive
    // delete throws, but we still want the MMKV slot gone so the
    // user isn't stuck staring at an unresolvable pending entry.
    setFileSystemFailure(true)
    savePendingUpload({
      localUri: 'file:///vanished.m4a',
      clientRecordedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    })
    const out = await loadPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(mmkvStore.has('cyggie.pending-upload.v1')).toBe(false)
  })

  it('evicts entries with a malformed clientRecordedAt timestamp', async () => {
    savePendingUpload({
      localUri: 'file:///bad-ts.m4a',
      clientRecordedAt: 'not a date',
    })
    const out = await loadPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(mmkvStore.has('cyggie.pending-upload.v1')).toBe(false)
  })

  it('returns null without filesystem touches when no entry exists', async () => {
    const out = await loadPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(fileSystemCalls).toHaveLength(0)
  })
})
