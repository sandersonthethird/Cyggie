import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'

const DOCS = join(tmpdir(), 'cyggie-routing-docs')
const TEMP = join(tmpdir(), 'cyggie-routing-temp')
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'documents' ? DOCS : TEMP) },
}))

import { setStoragePath, setResolvedSharedRoot, getStoragePath, getStagingDir } from '../main/storage/paths'
import {
  rootForMeeting,
  resolveExistingFile,
  placeFinalizedFile,
  stagingPathFor,
  isTwoTierStorageEnabled,
  recordingProbeDirs,
  resolveRecordingFilePath,
  setTwoTierSettingProvider,
  __setTwoTierFlagForTests,
  __resetResolveCacheForTests,
  invalidateResolveCache,
} from '../main/storage/routing'
import { dirname } from 'path'

// Two real on-disk roots: a local (private) root and a "shared" root.
const LOCAL = join(tmpdir(), 'cyggie-routing-local')
const SHARED = join(tmpdir(), 'cyggie-routing-shared')

function seedTranscript(root: string, filename: string, body = 'x'): void {
  const dir = join(root, 'transcripts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), body)
}

beforeEach(() => {
  setStoragePath(LOCAL) // private root == storagePath today
  setResolvedSharedRoot(null)
  __setTwoTierFlagForTests(null)
  setTwoTierSettingProvider(null)
  __resetResolveCacheForTests()
  rmSync(LOCAL, { recursive: true, force: true })
  rmSync(SHARED, { recursive: true, force: true })
})

afterAll(() => {
  __setTwoTierFlagForTests(null)
  rmSync(LOCAL, { recursive: true, force: true })
  rmSync(SHARED, { recursive: true, force: true })
})

describe('rootForMeeting — single source of truth for which root', () => {
  it('FLAG OFF → identity: everything resolves to the single storagePath', () => {
    __setTwoTierFlagForTests(false)
    expect(rootForMeeting({ isPrivate: false })).toEqual({ kind: 'root', root: getStoragePath() })
    expect(rootForMeeting({ isPrivate: true })).toEqual({ kind: 'root', root: getStoragePath() })
  })

  it('FLAG ON, private meeting → private (local) root', () => {
    __setTwoTierFlagForTests(true)
    expect(rootForMeeting({ isPrivate: true })).toEqual({ kind: 'root', root: LOCAL })
  })

  it('FLAG ON, fail-closed: null/undefined is_private routes PRIVATE, never shared', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    expect(rootForMeeting({ isPrivate: null })).toEqual({ kind: 'root', root: LOCAL })
    expect(rootForMeeting({})).toEqual({ kind: 'root', root: LOCAL })
  })

  it('FLAG ON, public meeting + resolved shared root → shared root', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    expect(rootForMeeting({ isPrivate: false })).toEqual({ kind: 'root', root: SHARED })
  })

  it('FLAG ON, public meeting + UNRESOLVED shared root → HOLD (no silent local fallback, Issue 3A)', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(null)
    expect(rootForMeeting({ isPrivate: false })).toEqual({
      kind: 'hold',
      reason: 'shared-unresolved',
    })
  })
})

describe('isTwoTierStorageEnabled — defaults OFF', () => {
  it('is false unless the flag/env opts in', () => {
    __setTwoTierFlagForTests(null)
    delete process.env['CYGGIE_TWO_TIER_STORAGE']
    expect(isTwoTierStorageEnabled()).toBe(false)
  })
})

describe('isTwoTierStorageEnabled — injected setting provider (Slice 3b)', () => {
  beforeEach(() => {
    __setTwoTierFlagForTests(null)
    delete process.env['CYGGIE_TWO_TIER_STORAGE']
  })
  afterAll(() => {
    setTwoTierSettingProvider(null)
    __setTwoTierFlagForTests(null)
  })

  it('reads the provider when no test/env override is set', () => {
    setTwoTierSettingProvider(() => true)
    expect(isTwoTierStorageEnabled()).toBe(true)
    setTwoTierSettingProvider(() => false)
    expect(isTwoTierStorageEnabled()).toBe(false)
  })

  it('test override and env both win over the provider', () => {
    setTwoTierSettingProvider(() => false)
    __setTwoTierFlagForTests(true)
    expect(isTwoTierStorageEnabled()).toBe(true) // test override wins
    __setTwoTierFlagForTests(null)
    process.env['CYGGIE_TWO_TIER_STORAGE'] = '1'
    expect(isTwoTierStorageEnabled()).toBe(true) // env wins over provider
    delete process.env['CYGGIE_TWO_TIER_STORAGE']
    setTwoTierSettingProvider(null)
  })
})

describe('resolveExistingFile — implied root first, fallback once, cached', () => {
  it('FLAG OFF → single-root lookup', () => {
    __setTwoTierFlagForTests(false)
    seedTranscript(LOCAL, 'a.md')
    expect(resolveExistingFile({ id: 'm1', isPrivate: false }, 'transcript', 'a.md')).toBe(
      join(LOCAL, 'transcripts', 'a.md'),
    )
    expect(resolveExistingFile({ id: 'm1', isPrivate: false }, 'transcript', 'missing.md')).toBeNull()
  })

  it('FLAG ON, public file lives in shared → found via shared first', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    seedTranscript(SHARED, 'pub.md')
    expect(resolveExistingFile({ id: 'm2', isPrivate: false }, 'transcript', 'pub.md')).toBe(
      join(SHARED, 'transcripts', 'pub.md'),
    )
  })

  it('FLAG ON, falls back to the OTHER root when not in the implied one (in-flight relocation)', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    // Meeting is marked public, but the file still physically sits in the private
    // root (e.g. relocation hasn't run yet) — resolver must find it via fallback.
    seedTranscript(LOCAL, 'moving.md')
    expect(resolveExistingFile({ id: 'm3', isPrivate: false }, 'transcript', 'moving.md')).toBe(
      join(LOCAL, 'transcripts', 'moving.md'),
    )
  })

  it('cache invalidation after a relocation forces re-resolution', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    seedTranscript(LOCAL, 'reloc.md')
    const first = resolveExistingFile({ id: 'm4', isPrivate: false }, 'transcript', 'reloc.md')
    expect(first).toBe(join(LOCAL, 'transcripts', 'reloc.md'))
    // Simulate relocation: move the file to shared, invalidate, re-resolve.
    rmSync(join(LOCAL, 'transcripts', 'reloc.md'))
    seedTranscript(SHARED, 'reloc.md')
    invalidateResolveCache('m4')
    expect(resolveExistingFile({ id: 'm4', isPrivate: false }, 'transcript', 'reloc.md')).toBe(
      join(SHARED, 'transcripts', 'reloc.md'),
    )
  })
})

describe('placeFinalizedFile — stage→finalize (2A) + hold (3A)', () => {
  const STAGING = join(tmpdir(), 'cyggie-routing-staging')

  function stage(filename: string, body = 'data'): string {
    mkdirSync(STAGING, { recursive: true })
    const p = join(STAGING, filename)
    writeFileSync(p, body)
    return p
  }

  it('places a private meeting\'s staged file into the local root and removes the staging copy', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    const src = stage('rec.mp4', 'video')
    const res = placeFinalizedFile({ id: 'p1', isPrivate: true }, 'recording', 'rec.mp4', src)
    expect(res).toEqual({ kind: 'placed', path: join(LOCAL, 'recordings', 'rec.mp4') })
    expect(existsSync(src)).toBe(false) // moved, not copied-and-left
    expect(readFileSync(join(LOCAL, 'recordings', 'rec.mp4'), 'utf-8')).toBe('video')
  })

  it('places a public meeting\'s staged file into the shared root', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    const src = stage('pub.md')
    const res = placeFinalizedFile({ id: 'p2', isPrivate: false }, 'transcript', 'pub.md', src)
    expect(res).toEqual({ kind: 'placed', path: join(SHARED, 'transcripts', 'pub.md') })
    expect(existsSync(join(SHARED, 'transcripts', 'pub.md'))).toBe(true)
  })

  it('HOLDS a public file in staging when the shared root is unresolved (no silent local mis-file)', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(null)
    const src = stage('held.md')
    const res = placeFinalizedFile({ id: 'p3', isPrivate: false }, 'transcript', 'held.md', src)
    expect(res).toEqual({ kind: 'held', reason: 'shared-unresolved', stagingPath: src })
    expect(existsSync(src)).toBe(true) // still in staging, NOT moved to local
    expect(existsSync(join(LOCAL, 'transcripts', 'held.md'))).toBe(false)
  })

  it('FLAG OFF → places into the single storagePath root (identity)', () => {
    __setTwoTierFlagForTests(false)
    const src = stage('legacy.md')
    const res = placeFinalizedFile({ id: 'p4', isPrivate: false }, 'summary', 'legacy.md', src)
    expect(res).toEqual({ kind: 'placed', path: join(getStoragePath(), 'summaries', 'legacy.md') })
  })

  it('a HELD public file (shared unresolved) stays readable via the staging fallback', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(null) // public → HOLD
    const filename = 'heldread.md'
    // Writer stages at the canonical staging path, then places (→ held).
    const src = stagingPathFor('transcript', filename)
    mkdirSync(dirname(src), { recursive: true })
    writeFileSync(src, 'pending content')
    const res = placeFinalizedFile({ id: 'h1', isPrivate: false }, 'transcript', filename, src)
    expect(res.kind).toBe('held')
    // resolveExistingFile finds the held file in staging so the desktop can read it.
    expect(resolveExistingFile({ id: 'h1', isPrivate: false }, 'transcript', filename)).toBe(src)
    rmSync(src, { force: true })
  })

  afterAll(() => rmSync(STAGING, { recursive: true, force: true }))
})

describe('recordingProbeDirs / resolveRecordingFilePath — media:// filename probe (Slice 3d)', () => {
  function seedRecording(root: string, filename: string, body = 'mp4'): void {
    const dir = join(root, 'recordings')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, filename), body)
  }
  // The held-recording slot is the canonical staging path's directory.
  const heldDir = dirname(stagingPathFor('recording', 'x'))

  beforeEach(() => rmSync(heldDir, { recursive: true, force: true }))
  afterAll(() => rmSync(heldDir, { recursive: true, force: true }))

  it('FLAG OFF → probes only the single recordings dir', () => {
    __setTwoTierFlagForTests(false)
    expect(recordingProbeDirs()).toEqual([join(getStoragePath(), 'recordings')])
  })

  it('FLAG ON → probes private root, shared root, then the held-staging slot', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    expect(recordingProbeDirs()).toEqual([
      join(LOCAL, 'recordings'),
      join(SHARED, 'recordings'),
      join(getStagingDir(), 'recording'),
    ])
  })

  it('FLAG ON → omits the shared root from the probe list when unresolved', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(null)
    expect(recordingProbeDirs()).toEqual([
      join(LOCAL, 'recordings'),
      join(getStagingDir(), 'recording'),
    ])
  })

  it('resolves a public recording living in the shared root', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    seedRecording(SHARED, 'pub.mp4')
    expect(resolveRecordingFilePath('pub.mp4')).toBe(join(SHARED, 'recordings', 'pub.mp4'))
  })

  it('resolves a HELD recording from the staging slot (shared root unresolved)', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(null)
    const held = stagingPathFor('recording', 'held.mp4')
    mkdirSync(dirname(held), { recursive: true })
    writeFileSync(held, 'mp4')
    expect(resolveRecordingFilePath('held.mp4')).toBe(held)
  })

  it('returns null for a missing file and rejects ../ path traversal', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    expect(resolveRecordingFilePath('does-not-exist.mp4')).toBeNull()
    expect(resolveRecordingFilePath('../../../../etc/hosts')).toBeNull()
  })

  it('FLAG OFF → single-root lookup (today’s behavior)', () => {
    __setTwoTierFlagForTests(false)
    seedRecording(getStoragePath(), 'legacy.mp4')
    expect(resolveRecordingFilePath('legacy.mp4')).toBe(
      join(getStoragePath(), 'recordings', 'legacy.mp4'),
    )
    expect(resolveRecordingFilePath('missing.mp4')).toBeNull()
  })
})
