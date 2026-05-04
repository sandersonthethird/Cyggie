// @vitest-environment jsdom
/**
 * useChatStreaming — extracted from the legacy ChatInterface and centralized.
 *
 *   What this exercises:
 *     1. Subscribe-ONCE race fix: the CHAT_PROGRESS subscription mounts on
 *        first render and is gated by isStreamingRef. Chunks emitted during
 *        the in-flight invoke are accumulated into streamedContent.
 *     2. 60s no-progress watchdog: if no chunk arrives within stallTimeoutMs,
 *        the hook fires abort() and surfaces the "stalled" error to onError.
 *     3. Abort: rejected aborts are caught and logged (don't crash the hook).
 *     4. Centralized error rescue: api.invoke rejection runs through
 *        parseChatError; user sees a friendly message via onError.
 *     5. Abort-induced rejection: streamedContent partial is delivered to
 *        onAbortPartial.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const invokeMock = vi.fn()
const onMock = vi.fn()
let progressCallback: ((chunk: unknown) => void) | null = null

vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: (channel: string, cb: (chunk: unknown) => void) => {
      onMock(channel, cb)
      if (channel === 'chat:progress') progressCallback = cb
      return () => {
        if (progressCallback === cb) progressCallback = null
      }
    },
  },
}))

import { useChatStreaming } from '../renderer/hooks/useChatStreaming'
import type { ChatKind } from '../renderer/lib/chat-channels'

const GLOBAL_KIND: ChatKind = { kind: 'global' }

beforeEach(() => {
  invokeMock.mockReset()
  onMock.mockReset()
  progressCallback = null
})

describe('useChatStreaming', () => {
  it('subscribes to CHAT_PROGRESS once on mount', () => {
    renderHook(() => useChatStreaming())
    const channels = onMock.mock.calls.map((c) => c[0])
    expect(channels).toContain('chat:progress')
    // Only ONE subscription on mount.
    expect(channels.filter((c) => c === 'chat:progress').length).toBe(1)
  })

  it('accumulates streamed chunks during an in-flight send and clears on resolve', async () => {
    let resolveInvoke: (v: string) => void = () => {}
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'chat:abort-all') return Promise.resolve()
      return new Promise<string>((r) => {
        resolveInvoke = r
      })
    })

    const onComplete = vi.fn()
    const { result } = renderHook(() => useChatStreaming({ onComplete }))

    // Begin the turn (don't await — we want to fire chunks while it's in-flight).
    let sendDone: Promise<void> | null = null
    act(() => {
      sendDone = result.current.send({ kind: GLOBAL_KIND, question: 'q' })
    })

    expect(result.current.isLoading).toBe(true)
    expect(progressCallback).toBeTruthy()

    act(() => {
      progressCallback!('Hel')
      progressCallback!('lo, ')
      progressCallback!('world.')
    })
    expect(result.current.streamedContent).toBe('Hello, world.')

    // Resolve the invoke with the final response → streamedContent clears,
    // onComplete fires.
    await act(async () => {
      resolveInvoke('Hello, world.')
      await sendDone
    })
    expect(onComplete).toHaveBeenCalledWith('Hello, world.')
    expect(result.current.streamedContent).toBe('')
    expect(result.current.isLoading).toBe(false)
  })

  it('ignores chunks that arrive when not streaming (gate by isStreamingRef)', () => {
    const { result } = renderHook(() => useChatStreaming())
    expect(result.current.isLoading).toBe(false)

    act(() => {
      progressCallback!('orphan chunk')
    })
    expect(result.current.streamedContent).toBe('')
  })

  it('routes parsed errors through onError on api.invoke rejection', async () => {
    invokeMock.mockImplementation(() => Promise.reject(new Error('something exploded')))
    const onError = vi.fn()
    const { result } = renderHook(() => useChatStreaming({ onError }))

    await act(async () => {
      await result.current.send({ kind: GLOBAL_KIND, question: 'q' })
    })

    expect(onError).toHaveBeenCalled()
    // Generic error path returns the friendly fallback message.
    expect(onError.mock.calls[0][0]).toMatch(/something went wrong|please try again/i)
    expect(result.current.isLoading).toBe(false)
  })

  it('delivers partial content via onAbortPartial when aborted mid-stream', async () => {
    let resolveInvoke: ((v: string) => void) | null = null
    let rejectInvoke: ((e: Error) => void) | null = null
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'chat:abort-all') return Promise.resolve()
      return new Promise<string>((res, rej) => {
        resolveInvoke = res
        rejectInvoke = rej
      })
    })

    const onAbortPartial = vi.fn()
    const onComplete = vi.fn()
    const { result } = renderHook(() => useChatStreaming({ onComplete, onAbortPartial }))

    let sendDone: Promise<void> | null = null
    act(() => {
      sendDone = result.current.send({ kind: GLOBAL_KIND, question: 'q' })
    })

    act(() => {
      progressCallback!('partial...')
    })

    // Simulate the main process aborting the in-flight call.
    await act(async () => {
      rejectInvoke!(new Error('aborted'))
      await sendDone
    })

    expect(onAbortPartial).toHaveBeenCalledWith('partial...')
    expect(onComplete).not.toHaveBeenCalled()
    expect(result.current.isLoading).toBe(false)
  })

  it('catches abort() rejections silently (no crash)', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'chat:abort-all') return Promise.reject(new Error('abort failed'))
      return new Promise<string>(() => {})
    })

    const { result } = renderHook(() => useChatStreaming())

    // Should not throw — failed abort is logged + swallowed.
    await act(async () => {
      await result.current.abort(GLOBAL_KIND)
    })
    // Abort channel was invoked.
    expect(invokeMock).toHaveBeenCalledWith('chat:abort-all')
  })

  it('fires the watchdog when no chunks arrive within stallTimeoutMs', async () => {
    vi.useFakeTimers()
    let _resolve: ((v: string) => void) | null = null
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'chat:abort-all') return Promise.resolve()
      return new Promise<string>((res) => {
        _resolve = res
      })
    })

    const onError = vi.fn()
    const { result } = renderHook(() =>
      useChatStreaming({ onError, stallTimeoutMs: 1000 })
    )

    let sendDone: Promise<void> | null = null
    act(() => {
      sendDone = result.current.send({ kind: GLOBAL_KIND, question: 'q' })
    })

    // No chunks; advance 1.1s — watchdog should fire abort + onError.
    act(() => {
      vi.advanceTimersByTime(1100)
    })

    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/stalled/i))
    // Abort was fired on the abort channel.
    expect(invokeMock.mock.calls.some((c) => c[0] === 'chat:abort-all')).toBe(true)

    vi.useRealTimers()
    // Cleanup hanging promise so the test runner doesn't complain.
    _resolve?.('done')
    await sendDone?.catch(() => {})
  })

  it('resets the watchdog on each chunk', async () => {
    vi.useFakeTimers()
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'chat:abort-all') return Promise.resolve()
      return new Promise<string>(() => {})
    })

    const onError = vi.fn()
    const { result } = renderHook(() =>
      useChatStreaming({ onError, stallTimeoutMs: 1000 })
    )

    act(() => {
      void result.current.send({ kind: GLOBAL_KIND, question: 'q' })
    })

    // Advance 800ms, then deliver a chunk → watchdog resets.
    act(() => {
      vi.advanceTimersByTime(800)
    })
    act(() => {
      progressCallback!('hi ')
    })
    // Advance another 800ms (total 1600ms but only 800ms since last chunk).
    act(() => {
      vi.advanceTimersByTime(800)
    })
    expect(onError).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})
