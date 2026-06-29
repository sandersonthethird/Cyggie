import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, writeFileSync, rmSync } from 'fs'

const DOCS = join(tmpdir(), 'cyggie-routing-docs')
const TEMP = join(tmpdir(), 'cyggie-routing-temp')
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'documents' ? DOCS : TEMP) },
}))

import { setStoragePath, setResolvedSharedRoot, getStoragePath } from '../main/storage/paths'
import {
  rootForMeeting,
  resolveExistingFile,
  isTwoTierStorageEnabled,
  __setTwoTierFlagForTests,
  __resetResolveCacheForTests,
  invalidateResolveCache,
} from '../main/storage/routing'

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
