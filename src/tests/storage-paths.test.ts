import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

// Electron's `app` is the only external dependency of paths.ts. Mock it so the
// module resolves a deterministic documents dir + temp dir under the OS tmpdir.
const DOCS = join(tmpdir(), 'cyggie-paths-test-docs')
const TEMP = join(tmpdir(), 'cyggie-paths-test-temp')
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'documents' ? DOCS : TEMP),
  },
}))

import {
  getDefaultStoragePath,
  getStoragePath,
  setStoragePath,
  getTranscriptsDir,
  getSummariesDir,
  getRecordingsDir,
  getMemosDir,
  getDatabasePath,
  getPrivateRoot,
  getSharedRoot,
  setResolvedSharedRoot,
  getStagingDir,
} from '../main/storage/paths'

describe('storage paths — Slice 1 two-root primitives', () => {
  beforeEach(() => {
    // Reset to the default (documents) root before each test.
    setStoragePath(getDefaultStoragePath())
  })

  describe('behavior-preserving refactor (Issue 1A — flag OFF == identity)', () => {
    it('dir getters with no root argument resolve against the current storagePath, exactly as before', () => {
      const root = getStoragePath()
      expect(getTranscriptsDir()).toBe(join(root, 'transcripts'))
      expect(getSummariesDir()).toBe(join(root, 'summaries'))
      expect(getRecordingsDir()).toBe(join(root, 'recordings'))
      expect(getMemosDir()).toBe(join(root, 'memos'))
    })

    it('an explicit root argument overrides the default (the Slice-3 routing hook)', () => {
      const other = join(tmpdir(), 'some-other-root')
      expect(getTranscriptsDir(other)).toBe(join(other, 'transcripts'))
      expect(getRecordingsDir(other)).toBe(join(other, 'recordings'))
    })

    it('changing storagePath flows through to the no-arg getters', () => {
      const custom = join(tmpdir(), 'cyggie-custom-root')
      setStoragePath(custom)
      expect(getStoragePath()).toBe(custom)
      expect(getSummariesDir()).toBe(join(custom, 'summaries'))
    })
  })

  describe('roots: private == local storagePath; shared is resolver-set (null until then)', () => {
    it('getPrivateRoot returns the current storagePath today', () => {
      const custom = join(tmpdir(), 'cyggie-root-placeholder')
      setStoragePath(custom)
      expect(getPrivateRoot()).toBe(custom)
    })

    it('getSharedRoot is null until the resolver sets it, then reflects the set value', () => {
      setResolvedSharedRoot(null)
      expect(getSharedRoot()).toBeNull() // never silently falls back to local (Issue 3A)
      const drive = join(tmpdir(), 'cyggie-shared-mount')
      setResolvedSharedRoot(drive)
      expect(getSharedRoot()).toBe(drive)
      setResolvedSharedRoot(null) // reset for other tests
    })
  })

  describe('database stays at the single local storagePath, never a per-meeting root', () => {
    it('getDatabasePath ignores any routing and uses storagePath', () => {
      const custom = join(tmpdir(), 'cyggie-db-root')
      setStoragePath(custom)
      expect(getDatabasePath()).toBe(join(custom, 'echovault.db'))
    })
  })

  describe('staging dir (Issue 2A) is always local under the OS temp dir', () => {
    it('getStagingDir resolves under the OS temp path, not under storagePath/Drive', () => {
      setStoragePath(join(tmpdir(), 'cyggie-some-drive-folder'))
      expect(getStagingDir()).toBe(join(TEMP, 'cyggie-staging'))
    })
  })
})
