/**
 * Full-lifecycle integration test for two-tier storage (eng-review mandate,
 * Slice 3b). Exercises the real routing + file-manager + relocate + hold-queue
 * primitives end to end — no mocks beyond electron's path provider.
 *
 *   A. public finalize → read resolves → toggle private → relocate → read resolves
 *   B. shared root unavailable → HOLD → recover (drain) → read resolves
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'

const DOCS = join(tmpdir(), 'cyggie-life-docs')
const TEMP = join(tmpdir(), 'cyggie-life-temp')
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'documents' ? DOCS : TEMP) },
}))

import {
  setStoragePath,
  setResolvedSharedRoot,
  getTranscriptsDir,
  getSummariesDir,
  getRecordingsDir,
} from '../main/storage/paths'
import {
  placeFinalizedFile,
  stagingPathFor,
  __setTwoTierFlagForTests,
  __resetResolveCacheForTests,
} from '../main/storage/routing'
import {
  writeTranscript,
  readTranscript,
  writeSummary,
  readSummary,
} from '../main/storage/file-manager'
import { relocateMeetingFiles } from '../main/storage/relocate'
import {
  getHoldQueueDepth,
  drainHoldQueue,
  __resetHoldQueueForTests,
} from '../main/storage/hold-queue'

const LOCAL = join(tmpdir(), 'cyggie-life-local') // private root == storagePath
const SHARED = join(tmpdir(), 'cyggie-life-shared')

/** Simulate a finalized recording landing in its routed root (stands in for the
 *  ffmpeg finalize, which can't run in a unit test). Returns the filename. */
function placeRecording(meetingId: string, isPrivate: boolean, filename: string, body = 'mp4'): void {
  const staged = join(TEMP, `${meetingId}.stage.mp4`)
  writeFileSync(staged, body)
  const res = placeFinalizedFile({ id: meetingId, isPrivate }, 'recording', filename, staged)
  if (res.kind !== 'placed') throw new Error('expected recording to place')
}

beforeEach(() => {
  for (const d of [LOCAL, SHARED, join(TEMP, 'cyggie-staging')]) {
    rmSync(d, { recursive: true, force: true })
  }
  setStoragePath(LOCAL)
  setResolvedSharedRoot(null)
  __setTwoTierFlagForTests(true)
  __resetResolveCacheForTests()
  __resetHoldQueueForTests()
})

afterAll(() => {
  __setTwoTierFlagForTests(null)
  __resetHoldQueueForTests()
  for (const d of [LOCAL, SHARED, DOCS, join(TEMP, 'cyggie-staging')]) {
    rmSync(d, { recursive: true, force: true })
  }
})

describe('two-tier lifecycle — public finalize → toggle private → relocate', () => {
  it('routes a public meeting to shared, then relocates every file to local on toggle', () => {
    setResolvedSharedRoot(SHARED)
    const id = 'mtgPub'

    // Public finalize: transcript + summary + recording all land in the shared root.
    const transcriptFile = writeTranscript(id, 'T-body', undefined, undefined, undefined, false)
    const summaryFile = writeSummary(id, 'S-body', undefined, undefined, undefined, false)
    const recordingFile = 'mtgPub.mp4'
    placeRecording(id, false, recordingFile)

    expect(existsSync(join(getTranscriptsDir(SHARED), transcriptFile))).toBe(true)
    expect(existsSync(join(getSummariesDir(SHARED), summaryFile))).toBe(true)
    expect(existsSync(join(getRecordingsDir(SHARED), recordingFile))).toBe(true)

    // Reads resolve from shared.
    expect(readTranscript(transcriptFile, { id, isPrivate: false })).toBe('T-body')
    expect(readSummary(summaryFile, { id, isPrivate: false })).toBe('S-body')

    // Toggle → private: relocate every file to the local root.
    const res = relocateMeetingFiles(id, true, {
      transcript: transcriptFile,
      summary: summaryFile,
      recording: recordingFile,
    })
    expect(res.held).toBe(false)
    expect(res.moved.map((m) => m.kind).sort()).toEqual(['recording', 'summary', 'transcript'])

    // Files now live in local; shared copies are gone.
    expect(existsSync(join(getTranscriptsDir(LOCAL), transcriptFile))).toBe(true)
    expect(existsSync(join(getSummariesDir(LOCAL), summaryFile))).toBe(true)
    expect(existsSync(join(getRecordingsDir(LOCAL), recordingFile))).toBe(true)
    expect(existsSync(join(getTranscriptsDir(SHARED), transcriptFile))).toBe(false)
    expect(existsSync(join(getRecordingsDir(SHARED), recordingFile))).toBe(false)

    // Reads still resolve, now from local, under the new privacy.
    expect(readTranscript(transcriptFile, { id, isPrivate: true })).toBe('T-body')
    expect(readSummary(summaryFile, { id, isPrivate: true })).toBe('S-body')
  })
})

describe('two-tier lifecycle — shared unavailable → HOLD → recover', () => {
  it('holds a public file when shared is unresolved, then drains it on recovery', () => {
    // Shared root unresolved at finalize.
    setResolvedSharedRoot(null)
    const id = 'mtgHold'

    // Public summary write → HELD (file-manager enqueues into the hold queue).
    const summaryFile = writeSummary(id, 'held-body', undefined, undefined, undefined, false)
    expect(getHoldQueueDepth()).toBe(1)
    expect(existsSync(join(getSummariesDir(SHARED), summaryFile))).toBe(false)
    expect(existsSync(join(getSummariesDir(LOCAL), summaryFile))).toBe(false)
    // Staged + readable via the staging fallback meanwhile.
    expect(existsSync(stagingPathFor('summary', summaryFile))).toBe(true)
    expect(readSummary(summaryFile, { id, isPrivate: false })).toBe('held-body')

    // Drive mounts: resolve the shared root + drain.
    setResolvedSharedRoot(SHARED)
    const drain = drainHoldQueue()
    expect(drain).toEqual({ placed: 1, remaining: 0 })
    expect(getHoldQueueDepth()).toBe(0)

    // File is now in shared and reads resolve there.
    expect(existsSync(join(getSummariesDir(SHARED), summaryFile))).toBe(true)
    expect(existsSync(stagingPathFor('summary', summaryFile))).toBe(false)
    expect(readSummary(summaryFile, { id, isPrivate: false })).toBe('held-body')
  })
})
