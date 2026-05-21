// Unit tests for the multi-slot pendingUpload MMKV layer + 24hr eviction
// + v1→v2 migration. Runs under the root vitest config (node env) —
// MMKV and expo-file-system/legacy are both mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────────────────────
// In-memory MMKV double. Implements getAllKeys() so the multi-slot
// helpers can prefix-filter their way through entries.
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
    getAllKeys: () => Array.from(mmkvStore.keys()),
  },
}))

// expo-file-system/legacy: track deleteAsync calls; succeed by default.
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
  loadPendingUploadById,
  loadAllPendingUploads,
  loadPendingUploadByMeetingId,
  clearPendingUploadById,
  discardPendingUploadFileById,
  discardPendingUploadFileByMeetingId,
  loadMostRecentPendingUploadOrEvict,
  generateClientRecordingId,
  migrateLegacyEntry,
} = await import('../pending-upload')

const KEY_PREFIX = 'cyggie.pending-upload.v2:'
const LEGACY_KEY = 'cyggie.pending-upload.v1'

beforeEach(() => {
  mmkvStore.clear()
  fileSystemCalls.length = 0
  setFileSystemFailure(false)
})
afterEach(() => {
  mmkvStore.clear()
  fileSystemCalls.length = 0
})

describe('generateClientRecordingId', () => {
  it('produces collision-free ids (rec- prefix + timestamp + random)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(generateClientRecordingId())
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(/^rec-/)
  })
})

describe('save/load round trip', () => {
  it('round-trips a single entry under its clientRecordingId slot', () => {
    const recordedAt = new Date('2026-05-21T10:00:00Z').toISOString()
    savePendingUpload({
      clientRecordingId: 'rec-A',
      localUri: 'file:///audio.m4a',
      clientRecordedAt: recordedAt,
      meetingId: 'mtg-123',
    })
    const loaded = loadPendingUploadById('rec-A')
    expect(loaded?.localUri).toBe('file:///audio.m4a')
    expect(loaded?.meetingId).toBe('mtg-123')
    expect(loaded?.clientRecordedAt).toBe(recordedAt)
    // The slot key is the prefix + the id
    expect(mmkvStore.has(KEY_PREFIX + 'rec-A')).toBe(true)
  })

  it('returns null + clears the slot when a stored blob is corrupt', () => {
    mmkvStore.set(KEY_PREFIX + 'rec-corrupt', '{not json at all')
    const loaded = loadPendingUploadById('rec-corrupt')
    expect(loaded).toBeNull()
    expect(mmkvStore.has(KEY_PREFIX + 'rec-corrupt')).toBe(false)
  })

  it('returns null for missing slot without side effects', () => {
    expect(loadPendingUploadById('rec-nope')).toBeNull()
    expect(mmkvStore.size).toBe(0)
  })
})

describe('loadAllPendingUploads + loadPendingUploadByMeetingId', () => {
  it('returns multiple entries sorted most-recent first', () => {
    const t1 = new Date('2026-05-21T09:00:00Z').toISOString()
    const t2 = new Date('2026-05-21T10:00:00Z').toISOString()
    const t3 = new Date('2026-05-21T11:00:00Z').toISOString()
    savePendingUpload({ clientRecordingId: 'rec-1', localUri: 'f1', clientRecordedAt: t1 })
    savePendingUpload({ clientRecordingId: 'rec-3', localUri: 'f3', clientRecordedAt: t3 })
    savePendingUpload({ clientRecordingId: 'rec-2', localUri: 'f2', clientRecordedAt: t2 })

    const all = loadAllPendingUploads()
    expect(all.map((p) => p.clientRecordingId)).toEqual(['rec-3', 'rec-2', 'rec-1'])
  })

  it('skips and clears corrupt blobs while returning the rest', () => {
    savePendingUpload({
      clientRecordingId: 'rec-good',
      localUri: 'f',
      clientRecordedAt: new Date().toISOString(),
    })
    mmkvStore.set(KEY_PREFIX + 'rec-bad', '{not json')
    const all = loadAllPendingUploads()
    expect(all).toHaveLength(1)
    expect(all[0]?.clientRecordingId).toBe('rec-good')
    expect(mmkvStore.has(KEY_PREFIX + 'rec-bad')).toBe(false)
  })

  it('findByMeetingId returns the matching entry; null on miss', () => {
    savePendingUpload({
      clientRecordingId: 'rec-1',
      localUri: 'f1',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-aaa',
    })
    savePendingUpload({
      clientRecordingId: 'rec-2',
      localUri: 'f2',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-bbb',
    })
    expect(loadPendingUploadByMeetingId('mtg-bbb')?.clientRecordingId).toBe('rec-2')
    expect(loadPendingUploadByMeetingId('mtg-zzz')).toBeNull()
  })
})

describe('discard helpers', () => {
  it('discardPendingUploadFileById deletes file + clears slot for the specific id only', async () => {
    savePendingUpload({
      clientRecordingId: 'rec-keep',
      localUri: 'file:///keep.m4a',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-keep',
    })
    savePendingUpload({
      clientRecordingId: 'rec-discard',
      localUri: 'file:///discard.m4a',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-discard',
    })

    await discardPendingUploadFileById('rec-discard')
    expect(fileSystemCalls).toEqual([
      { uri: 'file:///discard.m4a', options: { idempotent: true } },
    ])
    expect(mmkvStore.has(KEY_PREFIX + 'rec-discard')).toBe(false)
    // Critical: the OTHER entry must be untouched. This is the
    // multi-slot safety-net invariant.
    expect(mmkvStore.has(KEY_PREFIX + 'rec-keep')).toBe(true)
  })

  it('discardPendingUploadFileById is a safe no-op when slot is empty', async () => {
    await discardPendingUploadFileById('rec-never-existed')
    expect(fileSystemCalls).toHaveLength(0)
  })

  it('discardPendingUploadFileByMeetingId finds by meetingId then discards', async () => {
    savePendingUpload({
      clientRecordingId: 'rec-A',
      localUri: 'file:///A.m4a',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-A',
    })
    savePendingUpload({
      clientRecordingId: 'rec-B',
      localUri: 'file:///B.m4a',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-B',
    })
    await discardPendingUploadFileByMeetingId('mtg-A')
    expect(mmkvStore.has(KEY_PREFIX + 'rec-A')).toBe(false)
    expect(mmkvStore.has(KEY_PREFIX + 'rec-B')).toBe(true)
  })

  it('discardPendingUploadFileByMeetingId is a no-op when no match', async () => {
    savePendingUpload({
      clientRecordingId: 'rec-A',
      localUri: 'file:///A.m4a',
      clientRecordedAt: new Date().toISOString(),
      meetingId: 'mtg-A',
    })
    await discardPendingUploadFileByMeetingId('mtg-never-existed')
    expect(mmkvStore.has(KEY_PREFIX + 'rec-A')).toBe(true)
    expect(fileSystemCalls).toHaveLength(0)
  })

  it('clearPendingUploadById drops the slot without touching the filesystem', () => {
    savePendingUpload({
      clientRecordingId: 'rec-A',
      localUri: 'file:///A.m4a',
      clientRecordedAt: new Date().toISOString(),
    })
    clearPendingUploadById('rec-A')
    expect(mmkvStore.has(KEY_PREFIX + 'rec-A')).toBe(false)
    expect(fileSystemCalls).toHaveLength(0)
  })
})

describe('loadMostRecentPendingUploadOrEvict', () => {
  it('returns the most-recent fresh entry without evicting it', async () => {
    const t1 = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1hr
    const t2 = new Date(Date.now() - 30 * 60 * 1000).toISOString() // 30min
    savePendingUpload({ clientRecordingId: 'rec-old', localUri: 'fo', clientRecordedAt: t1 })
    savePendingUpload({ clientRecordingId: 'rec-new', localUri: 'fn', clientRecordedAt: t2 })

    const out = await loadMostRecentPendingUploadOrEvict()
    expect(out?.clientRecordingId).toBe('rec-new')
    expect(fileSystemCalls).toHaveLength(0)
    expect(mmkvStore.size).toBe(2)
  })

  it('evicts ALL stale entries (not just the most recent) on every call', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    savePendingUpload({
      clientRecordingId: 'rec-stale-1',
      localUri: 'file:///s1.m4a',
      clientRecordedAt: stale,
    })
    savePendingUpload({
      clientRecordingId: 'rec-stale-2',
      localUri: 'file:///s2.m4a',
      clientRecordedAt: stale,
    })

    const out = await loadMostRecentPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(fileSystemCalls.map((c) => c.uri).sort()).toEqual([
      'file:///s1.m4a',
      'file:///s2.m4a',
    ])
    expect(mmkvStore.size).toBe(0)
  })

  it('returns fresh entry while evicting stale siblings in the same pass', async () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const fresh = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    savePendingUpload({
      clientRecordingId: 'rec-stale',
      localUri: 'file:///stale.m4a',
      clientRecordedAt: stale,
    })
    savePendingUpload({
      clientRecordingId: 'rec-fresh',
      localUri: 'file:///fresh.m4a',
      clientRecordedAt: fresh,
    })

    const out = await loadMostRecentPendingUploadOrEvict()
    expect(out?.clientRecordingId).toBe('rec-fresh')
    expect(fileSystemCalls).toEqual([
      { uri: 'file:///stale.m4a', options: { idempotent: true } },
    ])
    expect(mmkvStore.has(KEY_PREFIX + 'rec-stale')).toBe(false)
    expect(mmkvStore.has(KEY_PREFIX + 'rec-fresh')).toBe(true)
  })

  it('still clears MMKV when filesystem delete itself fails', async () => {
    setFileSystemFailure(true)
    savePendingUpload({
      clientRecordingId: 'rec-vanished',
      localUri: 'file:///vanished.m4a',
      clientRecordedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    })
    await loadMostRecentPendingUploadOrEvict()
    expect(mmkvStore.size).toBe(0)
  })

  it('evicts entries with malformed clientRecordedAt timestamps', async () => {
    savePendingUpload({
      clientRecordingId: 'rec-bad-ts',
      localUri: 'file:///bad-ts.m4a',
      clientRecordedAt: 'not a date',
    })
    const out = await loadMostRecentPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(mmkvStore.size).toBe(0)
  })

  it('returns null without filesystem touches when no entries exist', async () => {
    const out = await loadMostRecentPendingUploadOrEvict()
    expect(out).toBeNull()
    expect(fileSystemCalls).toHaveLength(0)
  })
})

describe('v1 → v2 migration', () => {
  it('moves a legacy single-slot entry into a v2 keyed slot + clears the v1 key', () => {
    const t = new Date('2026-05-21T08:00:00Z').toISOString()
    mmkvStore.set(
      LEGACY_KEY,
      JSON.stringify({
        localUri: 'file:///legacy.m4a',
        clientRecordedAt: t,
        meetingId: 'mtg-legacy',
      }),
    )
    migrateLegacyEntry()
    expect(mmkvStore.has(LEGACY_KEY)).toBe(false)
    // Exactly one v2 entry should now exist
    const all = loadAllPendingUploads()
    expect(all).toHaveLength(1)
    expect(all[0]?.localUri).toBe('file:///legacy.m4a')
    expect(all[0]?.meetingId).toBe('mtg-legacy')
    expect(all[0]?.clientRecordingId).toMatch(/^rec-/)
  })

  it('drops a malformed legacy blob without crashing', () => {
    mmkvStore.set(LEGACY_KEY, 'not json {{')
    expect(() => migrateLegacyEntry()).not.toThrow()
    expect(mmkvStore.has(LEGACY_KEY)).toBe(false)
    expect(loadAllPendingUploads()).toHaveLength(0)
  })

  it('is idempotent — second call is a no-op', () => {
    mmkvStore.set(
      LEGACY_KEY,
      JSON.stringify({
        localUri: 'file:///legacy.m4a',
        clientRecordedAt: new Date().toISOString(),
      }),
    )
    migrateLegacyEntry()
    migrateLegacyEntry() // should not double-create
    expect(loadAllPendingUploads()).toHaveLength(1)
  })

  it('runs inline on every loadAllPendingUploads() call as a fallback', () => {
    mmkvStore.set(
      LEGACY_KEY,
      JSON.stringify({
        localUri: 'file:///legacy.m4a',
        clientRecordedAt: new Date().toISOString(),
      }),
    )
    // We didn't call migrateLegacyEntry explicitly; loadAllPendingUploads
    // should still pick up the migrated entry.
    const all = loadAllPendingUploads()
    expect(all).toHaveLength(1)
    expect(mmkvStore.has(LEGACY_KEY)).toBe(false)
  })

  it('drops a legacy blob missing a localUri (not minimally well-formed)', () => {
    mmkvStore.set(LEGACY_KEY, JSON.stringify({ randomField: 'no useful data' }))
    migrateLegacyEntry()
    expect(mmkvStore.has(LEGACY_KEY)).toBe(false)
    expect(loadAllPendingUploads()).toHaveLength(0)
  })
})
