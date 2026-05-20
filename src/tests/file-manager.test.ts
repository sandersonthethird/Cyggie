/**
 * Unit test for summaryFileExists() helper.
 *
 * Stubs getSummariesDir() to a fresh tmp dir per test so we can exercise the
 * existsSync branch deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpRef: { dir: string } = { dir: '' }

vi.mock('../main/storage/paths', () => ({
  getStoragePath: () => tmpRef.dir,
  getTranscriptsDir: () => join(tmpRef.dir, 'transcripts'),
  getSummariesDir: () => tmpRef.dir,
  getRecordingsDir: () => join(tmpRef.dir, 'recordings'),
}))

// file-manager imports google-auth via hasDriveContentScope — stub it so we
// don't try to read user credentials in a unit test.
vi.mock('../main/calendar/google-auth', () => ({
  hasDriveContentScope: () => false,
}))

const { summaryFileExists } = await import('../main/storage/file-manager')

describe('summaryFileExists', () => {
  beforeEach(() => {
    tmpRef.dir = mkdtempSync(join(tmpdir(), 'file-manager-test-'))
  })

  afterEach(() => {
    rmSync(tmpRef.dir, { recursive: true, force: true })
  })

  it('returns false when filename is null', () => {
    expect(summaryFileExists(null)).toBe(false)
  })

  it('returns false when file does not exist', () => {
    expect(summaryFileExists('nonexistent.md')).toBe(false)
  })

  it('returns true when file exists in summaries dir', () => {
    writeFileSync(join(tmpRef.dir, 'present.md'), 'content', 'utf-8')
    expect(summaryFileExists('present.md')).toBe(true)
  })
})
