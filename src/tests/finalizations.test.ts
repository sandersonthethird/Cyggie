/**
 * Unit tests for the shared pending-finalizations registry.
 *
 * Pure module — no mocks needed.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  addPending,
  removePending,
  hasPending,
  getPending,
  getPendingForQuit,
  _resetForTests,
  _peekMap,
} from '../main/ipc/_finalizations'

beforeEach(() => {
  _resetForTests()
})

describe('pending finalizations registry', () => {
  it('addPending stores a promise under a composite key', () => {
    const p = Promise.resolve()
    addPending('video', 'm-1', p)
    expect(hasPending('video', 'm-1')).toBe(true)
    expect(getPending('video', 'm-1')).toBe(p)
  })

  it('removePending drops the entry', () => {
    addPending('video', 'm-1', Promise.resolve())
    removePending('video', 'm-1')
    expect(hasPending('video', 'm-1')).toBe(false)
  })

  it('video and recording for the same meetingId are independent entries', () => {
    const videoP = Promise.resolve()
    const audioP = Promise.resolve()
    addPending('video', 'm-1', videoP)
    addPending('recording', 'm-1', audioP)
    expect(hasPending('video', 'm-1')).toBe(true)
    expect(hasPending('recording', 'm-1')).toBe(true)
    expect(getPending('video', 'm-1')).toBe(videoP)
    expect(getPending('recording', 'm-1')).toBe(audioP)
    expect(_peekMap().size).toBe(2)
  })

  it('getPendingForQuit returns every value across both prefixes', () => {
    const a = Promise.resolve()
    const b = Promise.resolve()
    const c = Promise.resolve()
    addPending('video', 'm-1', a)
    addPending('recording', 'm-1', b)
    addPending('recording', 'm-2', c)
    const snapshot = getPendingForQuit()
    expect(snapshot).toHaveLength(3)
    expect(snapshot).toContain(a)
    expect(snapshot).toContain(b)
    expect(snapshot).toContain(c)
  })

  it('getPendingForQuit returns a snapshot, not a live reference', () => {
    addPending('video', 'm-1', Promise.resolve())
    const first = getPendingForQuit()
    addPending('recording', 'm-2', Promise.resolve())
    expect(first).toHaveLength(1) // didn't see the new addition
    expect(getPendingForQuit()).toHaveLength(2)
  })

  it('hasPending returns false for unknown keys', () => {
    expect(hasPending('video', 'never-added')).toBe(false)
    expect(getPending('recording', 'never-added')).toBeUndefined()
  })
})
