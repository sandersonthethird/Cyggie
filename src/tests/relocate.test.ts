/**
 * relocateMeetingFiles (Slice 3f) edge cases: flag-off no-op, held destination,
 * idempotent re-run. The happy-path move is covered by two-tier-lifecycle.test.ts.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'

const DOCS = join(tmpdir(), 'cyggie-reloc-docs')
const TEMP = join(tmpdir(), 'cyggie-reloc-temp')
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'documents' ? DOCS : TEMP) },
}))

import { setStoragePath, setResolvedSharedRoot, getSummariesDir } from '../main/storage/paths'
import { __setTwoTierFlagForTests, __resetResolveCacheForTests } from '../main/storage/routing'
import { relocateMeetingFiles } from '../main/storage/relocate'

const LOCAL = join(tmpdir(), 'cyggie-reloc-local')
const SHARED = join(tmpdir(), 'cyggie-reloc-shared')

function seedSummary(root: string, filename: string): void {
  const dir = getSummariesDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), 'x')
}

beforeEach(() => {
  rmSync(LOCAL, { recursive: true, force: true })
  rmSync(SHARED, { recursive: true, force: true })
  setStoragePath(LOCAL)
  setResolvedSharedRoot(SHARED)
  __setTwoTierFlagForTests(true)
  __resetResolveCacheForTests()
})

afterAll(() => {
  __setTwoTierFlagForTests(null)
  for (const d of [LOCAL, SHARED, DOCS]) rmSync(d, { recursive: true, force: true })
})

describe('relocateMeetingFiles', () => {
  it('is a no-op when the flag is off', () => {
    __setTwoTierFlagForTests(false)
    seedSummary(LOCAL, 'm.md')
    const res = relocateMeetingFiles('m', false, { summary: 'm.md' })
    expect(res).toEqual({ moved: [], skipped: 0, held: false })
    expect(existsSync(join(getSummariesDir(LOCAL), 'm.md'))).toBe(true)
  })

  it('HOLDS (leaves files in place) when toggling public while the shared root is unresolved', () => {
    setResolvedSharedRoot(null) // shared unavailable
    seedSummary(LOCAL, 'm.md') // currently private/local
    const res = relocateMeetingFiles('m', false /* → public */, { summary: 'm.md' })
    expect(res.held).toBe(true)
    expect(res.moved).toHaveLength(0)
    // File untouched in its current root.
    expect(existsSync(join(getSummariesDir(LOCAL), 'm.md'))).toBe(true)
  })

  it('is idempotent — a second run finds the file already in the destination and skips it', () => {
    seedSummary(SHARED, 'm.md') // public file already in shared
    const first = relocateMeetingFiles('m', false, { summary: 'm.md' })
    expect(first.moved).toHaveLength(0)
    expect(first.skipped).toBe(1) // already in dest
    const second = relocateMeetingFiles('m', false, { summary: 'm.md' })
    expect(second.skipped).toBe(1)
    expect(existsSync(join(getSummariesDir(SHARED), 'm.md'))).toBe(true)
  })
})
