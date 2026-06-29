/**
 * Flag-ON round-trip tests for the two-tier write/read wiring in file-manager
 * (Slice 3c). These exercise the REAL routing layer end to end — writeTranscript/
 * writeSummary stage→place into the meeting's routed root, and readTranscript/
 * readSummary/summaryFileExists resolve it back across roots.
 *
 * Mirrors storage-routing.test.ts: two real on-disk roots (a local/private root
 * == storagePath, and a "shared" root), electron mocked so getStagingDir resolves
 * to a tmp path, and google-auth stubbed (file-manager imports hasDriveContentScope).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs'

const DOCS = join(tmpdir(), 'cyggie-fm2t-docs')
const TEMP = join(tmpdir(), 'cyggie-fm2t-temp')
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'documents' ? DOCS : TEMP) },
}))

// file-manager imports hasDriveContentScope — stub so we never read credentials.
vi.mock('../main/calendar/google-auth', () => ({
  hasDriveContentScope: () => false,
}))

import { setStoragePath, setResolvedSharedRoot } from '../main/storage/paths'
import {
  __setTwoTierFlagForTests,
  __resetResolveCacheForTests,
} from '../main/storage/routing'
import {
  writeTranscript,
  readTranscript,
  writeSummary,
  readSummary,
  summaryFileExists,
  updateSummaryContent,
} from '../main/storage/file-manager'

const LOCAL = join(tmpdir(), 'cyggie-fm2t-local') // private root == storagePath
const SHARED = join(tmpdir(), 'cyggie-fm2t-shared')
const STAGING = join(TEMP, 'cyggie-staging')

beforeEach(() => {
  rmSync(LOCAL, { recursive: true, force: true })
  rmSync(SHARED, { recursive: true, force: true })
  rmSync(STAGING, { recursive: true, force: true })
  setStoragePath(LOCAL) // recreates LOCAL/{transcripts,summaries,...} via ensureStorageDirs
  setResolvedSharedRoot(null)
  __setTwoTierFlagForTests(null)
  __resetResolveCacheForTests()
})

afterAll(() => {
  __setTwoTierFlagForTests(null)
  for (const d of [LOCAL, SHARED, STAGING, DOCS]) rmSync(d, { recursive: true, force: true })
})

describe('file-manager two-tier round-trip (flag ON)', () => {
  it('private transcript → written to the LOCAL root and read back', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    const meeting = { id: 'mPriv', isPrivate: true }

    const filename = writeTranscript(meeting.id, 'private body', undefined, undefined, undefined, meeting.isPrivate)
    expect(existsSync(join(LOCAL, 'transcripts', filename))).toBe(true)
    expect(existsSync(join(SHARED, 'transcripts', filename))).toBe(false)
    expect(readTranscript(filename, meeting)).toBe('private body')
  })

  it('public summary → written to the SHARED root, read + existence-checked back', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    const meeting = { id: 'mPub', isPrivate: false }

    const filename = writeSummary(meeting.id, 'public body', undefined, undefined, undefined, meeting.isPrivate)
    expect(existsSync(join(SHARED, 'summaries', filename))).toBe(true)
    expect(existsSync(join(LOCAL, 'summaries', filename))).toBe(false)
    expect(readSummary(filename, meeting)).toBe('public body')
    expect(summaryFileExists(filename, meeting)).toBe(true)
  })

  it('public file with UNRESOLVED shared root → HELD in staging, still readable via fallback', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(null) // public → HOLD
    const meeting = { id: 'mHeld', isPrivate: false }

    const filename = writeSummary(meeting.id, 'held body', undefined, undefined, undefined, meeting.isPrivate)
    // Not mis-filed into either root...
    expect(existsSync(join(SHARED, 'summaries', filename))).toBe(false)
    expect(existsSync(join(LOCAL, 'summaries', filename))).toBe(false)
    // ...but held in staging and still resolvable for reads.
    expect(existsSync(join(STAGING, 'summary', filename))).toBe(true)
    expect(readSummary(filename, meeting)).toBe('held body')
    expect(summaryFileExists(filename, meeting)).toBe(true)
  })

  it('in-place updateSummaryContent rewrites the routed (shared) copy, not a legacy fork', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    const meeting = { id: 'mEdit', isPrivate: false }

    const filename = writeSummary(meeting.id, 'v1', undefined, undefined, undefined, meeting.isPrivate)
    updateSummaryContent(filename, 'v2', meeting)
    // The edit lands on the shared copy; no stray legacy-root duplicate.
    expect(readFileSync(join(SHARED, 'summaries', filename), 'utf-8')).toBe('v2')
    expect(existsSync(join(LOCAL, 'summaries', filename))).toBe(false)
    expect(readSummary(filename, meeting)).toBe('v2')
  })

  it('omitting the meeting ref is byte-identical legacy single-root behavior', () => {
    __setTwoTierFlagForTests(true)
    setResolvedSharedRoot(SHARED)
    // No isPrivate threaded → legacy write to the single storagePath, regardless of flag.
    const filename = writeTranscript('mLegacy', 'legacy body')
    expect(existsSync(join(LOCAL, 'transcripts', filename))).toBe(true)
    expect(readTranscript(filename)).toBe('legacy body')
  })
})
