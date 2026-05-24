// @vitest-environment jsdom

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock the api module before importing the hook — the hook reads
// `api.on` from this module. We expose a controllable `triggerEvent`
// so each test can simulate a sync-pull broadcast.
let lastSubscribedChannel: string | null = null
let lastUnsubscribe: (() => void) | null = null
const dispatchers = new Map<string, (...args: unknown[]) => void>()
function triggerEvent(channel: string, payload: unknown): void {
  const cb = dispatchers.get(channel)
  if (cb) cb(payload)
}

vi.mock('../index', () => ({
  api: {
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      lastSubscribedChannel = channel
      dispatchers.set(channel, callback)
      const unsubscribe = vi.fn(() => {
        dispatchers.delete(channel)
      })
      lastUnsubscribe = unsubscribe
      return unsubscribe
    }),
  },
}))

const invalidateTableMock = vi.fn()
vi.mock('../ipcCache', () => ({
  invalidateTable: (table: string) => invalidateTableMock(table),
  REMOTE_APPLIED_TO_TABLE: {
    'sync:meetings-remote-applied': 'meetings',
    'sync:notes-remote-applied': 'notes',
  },
}))

import { useRemoteApply } from '../useRemoteApply'
import { api as mockedApi } from '../index'

const MEETINGS_CHANNEL = 'sync:meetings-remote-applied'
const NOTES_CHANNEL = 'sync:notes-remote-applied'

beforeEach(() => {
  vi.useFakeTimers()
  invalidateTableMock.mockReset()
  lastSubscribedChannel = null
  lastUnsubscribe = null
  dispatchers.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useRemoteApply', () => {
  test('subscribes on mount + unsubscribes on unmount', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => useRemoteApply(MEETINGS_CHANNEL, callback))

    expect(lastSubscribedChannel).toBe(MEETINGS_CHANNEL)
    expect(lastUnsubscribe).not.toBeNull()

    unmount()
    expect(lastUnsubscribe).toHaveBeenCalled()
  })

  test('invalidates ipcCache immediately on broadcast (before debounce settles)', () => {
    const callback = vi.fn()
    renderHook(() => useRemoteApply(MEETINGS_CHANNEL, callback))

    act(() => {
      triggerEvent(MEETINGS_CHANNEL, { ids: ['m1'] })
    })

    // Cache invalidation is synchronous, no debounce.
    expect(invalidateTableMock).toHaveBeenCalledWith('meetings')
    // Callback is debounced — not yet fired.
    expect(callback).not.toHaveBeenCalled()
  })

  test('fires callback once with merged ids after 150ms debounce', () => {
    const callback = vi.fn()
    renderHook(() => useRemoteApply(MEETINGS_CHANNEL, callback))

    act(() => {
      triggerEvent(MEETINGS_CHANNEL, { ids: ['m1', 'm2'] })
      triggerEvent(MEETINGS_CHANNEL, { ids: ['m2', 'm3'] }) // dup m2
      triggerEvent(MEETINGS_CHANNEL, { ids: ['m4'] })
    })
    expect(callback).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(['m1', 'm2', 'm3', 'm4'])
  })

  test('separate channels get separate debounce timers', () => {
    const meetingsCb = vi.fn()
    const notesCb = vi.fn()
    renderHook(() => useRemoteApply(MEETINGS_CHANNEL, meetingsCb))
    renderHook(() => useRemoteApply(NOTES_CHANNEL, notesCb))

    act(() => {
      triggerEvent(MEETINGS_CHANNEL, { ids: ['m1'] })
      triggerEvent(NOTES_CHANNEL, { ids: ['n1'] })
    })
    expect(meetingsCb).not.toHaveBeenCalled()
    expect(notesCb).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(meetingsCb).toHaveBeenCalledWith(['m1'])
    expect(notesCb).toHaveBeenCalledWith(['n1'])
  })

  test('cleanup cancels pending timers (no callback after unmount)', () => {
    const callback = vi.fn()
    const { unmount } = renderHook(() => useRemoteApply(MEETINGS_CHANNEL, callback))

    act(() => {
      triggerEvent(MEETINGS_CHANNEL, { ids: ['m1'] })
    })
    unmount()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(callback).not.toHaveBeenCalled()
  })

  test('callback ref updates without re-subscribing', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const { rerender } = renderHook(({ cb }: { cb: typeof cb1 }) => useRemoteApply(MEETINGS_CHANNEL, cb), {
      initialProps: { cb: cb1 },
    })
    const subscribeCallCountAfterMount = (
      mockedApi.on as ReturnType<typeof vi.fn>
    ).mock.calls.length

    rerender({ cb: cb2 })

    // No re-subscription — callback updates via ref.
    const subscribeCallCountAfterRerender = (
      mockedApi.on as ReturnType<typeof vi.fn>
    ).mock.calls.length
    expect(subscribeCallCountAfterRerender).toBe(subscribeCallCountAfterMount)

    act(() => {
      triggerEvent(MEETINGS_CHANNEL, { ids: ['x'] })
      vi.advanceTimersByTime(150)
    })

    // The fresher callback (cb2) should fire, not cb1.
    expect(cb1).not.toHaveBeenCalled()
    expect(cb2).toHaveBeenCalledWith(['x'])
  })

  test('handles malformed payloads gracefully', () => {
    const callback = vi.fn()
    renderHook(() => useRemoteApply(MEETINGS_CHANNEL, callback))

    act(() => {
      // No ids field
      triggerEvent(MEETINGS_CHANNEL, {})
      // ids not an array
      triggerEvent(MEETINGS_CHANNEL, { ids: 'm1' })
      // ids contains non-strings
      triggerEvent(MEETINGS_CHANNEL, { ids: [1, 'm2', null] })
    })

    act(() => {
      vi.advanceTimersByTime(150)
    })

    // Only 'm2' is a valid string.
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(['m2'])
  })
})
