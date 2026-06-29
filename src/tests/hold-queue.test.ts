/**
 * Held-finalize queue (Issue 3A) — enqueue, depth, drain, change-listener.
 *
 * Mirrors storage-routing.test.ts: electron mocked, two real on-disk roots, the
 * routing flag + resolve cache reset per test. The queue drains by re-calling
 * placeFinalizedFile, so these exercise the real routing primitive end to end.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'fs'

const DOCS = join(tmpdir(), 'cyggie-holdq-docs')
const TEMP = join(tmpdir(), 'cyggie-holdq-temp')
vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'documents' ? DOCS : TEMP) },
}))

import { setStoragePath, setResolvedSharedRoot } from '../main/storage/paths'
import {
  placeFinalizedFile,
  stagingPathFor,
  __setTwoTierFlagForTests,
  __resetResolveCacheForTests,
} from '../main/storage/routing'
import {
  enqueueHeldFile,
  getHoldQueueDepth,
  drainHoldQueue,
  setHoldQueueChangeListener,
  __resetHoldQueueForTests,
  type HeldFile,
} from '../main/storage/hold-queue'

const LOCAL = join(tmpdir(), 'cyggie-holdq-local')
const SHARED = join(tmpdir(), 'cyggie-holdq-shared')

/** Stage a public file and HOLD it (shared root must be unresolved), returning
 *  the enqueue-ready descriptor. */
function holdPublic(kind: 'transcript' | 'summary' | 'recording', filename: string, body = 'x'): HeldFile {
  const sp = stagingPathFor(kind, filename)
  mkdirSync(dirname(sp), { recursive: true })
  writeFileSync(sp, body)
  const res = placeFinalizedFile({ id: 'm1', isPrivate: false }, kind, filename, sp)
  if (res.kind !== 'held') throw new Error('expected HOLD — shared root should be unresolved')
  return { meetingId: 'm1', kind, filename, stagingPath: res.stagingPath }
}

beforeEach(() => {
  rmSync(LOCAL, { recursive: true, force: true })
  rmSync(SHARED, { recursive: true, force: true })
  rmSync(join(TEMP, 'cyggie-staging'), { recursive: true, force: true })
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

describe('hold-queue — enqueue / depth', () => {
  it('enqueues and counts held files; same (meeting,kind,filename) is idempotent', () => {
    const h = holdPublic('summary', 'a.md')
    expect(getHoldQueueDepth()).toBe(0)
    enqueueHeldFile(h)
    expect(getHoldQueueDepth()).toBe(1)
    enqueueHeldFile(h) // same key → no growth
    expect(getHoldQueueDepth()).toBe(1)
    enqueueHeldFile(holdPublic('transcript', 'a.md')) // different kind → distinct
    expect(getHoldQueueDepth()).toBe(2)
  })
})

describe('hold-queue — drain', () => {
  it('drains into the shared root once it resolves; dequeues + moves the file', () => {
    enqueueHeldFile(holdPublic('summary', 'pub.md', 'body'))
    expect(getHoldQueueDepth()).toBe(1)

    setResolvedSharedRoot(SHARED) // root recovers
    const result = drainHoldQueue()

    expect(result).toEqual({ placed: 1, remaining: 0 })
    expect(getHoldQueueDepth()).toBe(0)
    expect(existsSync(join(SHARED, 'summaries', 'pub.md'))).toBe(true)
    // The staging copy was moved, not left behind.
    expect(existsSync(stagingPathFor('summary', 'pub.md'))).toBe(false)
  })

  it('keeps files queued when the shared root is still unresolved', () => {
    enqueueHeldFile(holdPublic('summary', 'still.md'))
    const result = drainHoldQueue() // shared still null
    expect(result).toEqual({ placed: 0, remaining: 1 })
    expect(getHoldQueueDepth()).toBe(1)
  })

  it('drops a held entry whose staging file vanished (manually deleted)', () => {
    const h = holdPublic('summary', 'gone.md')
    enqueueHeldFile(h)
    unlinkSync(h.stagingPath)
    setResolvedSharedRoot(SHARED)
    const result = drainHoldQueue()
    expect(result).toEqual({ placed: 0, remaining: 0 })
    expect(getHoldQueueDepth()).toBe(0)
  })
})

describe('hold-queue — change listener', () => {
  it('fires on a new enqueue and on drain placement, not on a duplicate enqueue', () => {
    const calls: number[] = []
    setHoldQueueChangeListener(() => calls.push(getHoldQueueDepth()))

    const h = holdPublic('summary', 'live.md')
    enqueueHeldFile(h)
    expect(calls).toEqual([1]) // enqueue → depth 1
    enqueueHeldFile(h) // duplicate → no fire
    expect(calls).toEqual([1])

    setResolvedSharedRoot(SHARED)
    drainHoldQueue()
    expect(calls).toEqual([1, 0]) // drained → depth 0
  })
})
