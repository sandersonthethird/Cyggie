// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

// Mocks must be hoisted before imports of the unit-under-test so that
// when useStartNewChat reaches for updateChatSession + Alert.alert it
// gets our stubs. react-native is aliased to a stub in vitest.config.ts
// already — extend it just enough to surface Alert here.
const alertSpy = vi.fn()
vi.mock('react-native', () => ({
  Alert: { alert: (...args: unknown[]) => alertSpy(...args) },
}))

const updateChatSessionMock = vi.fn()
vi.mock('../../lib/api/chat', () => ({
  updateChatSession: (...args: unknown[]) => updateChatSessionMock(...args),
}))

import { useStartNewChat } from '../useStartNewChat'

// =============================================================================
// Hook contract:
//   tap → abortInflight?.() ──┐
//                             ├─→ no-session  (sessionId missing) → no-op
//                             ├─→ empty       (messageCount === 0) → no-op
//                             ↓
//                  updateChatSession(isArchived: true)
//                             ↓
//   ┌───────────────┬─────────┴────────┬───────────────┐
//   200 OK         409 conflict       network throw
//   ↓              ↓                   ↓
//   invalidate     surfaceFailure      surfaceFailure
//   2x queryKeys   (Alert.alert)       (Alert.alert)
//   ↓
//   onStarted?()
//
// One test per branch + one for abort-ordering. Covers every codepath
// that materially changes user-visible behavior.
// =============================================================================

function makeWrapper(): {
  wrapper: (props: { children: ReactNode }) => React.JSX.Element
  qc: QueryClient
} {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
  return { wrapper, qc }
}

function baseArgs(overrides: Partial<Parameters<typeof useStartNewChat>[0]> = {}) {
  return {
    sessionId: 'sess_abc',
    contextKind: 'crm' as const,
    contextId: 'crm:global',
    messageCount: 4,
    ...overrides,
  }
}

beforeEach(() => {
  alertSpy.mockReset()
  updateChatSessionMock.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useStartNewChat', () => {
  test('1. no session loaded → {ok:false, reason:no-session}; nothing called', async () => {
    const { wrapper } = makeWrapper()
    const abortInflight = vi.fn()
    const onStarted = vi.fn()
    const { result } = renderHook(
      () =>
        useStartNewChat(baseArgs({ sessionId: undefined, abortInflight, onStarted })),
      { wrapper },
    )

    const outcome = await result.current.mutateAsync()

    expect(outcome).toEqual({ ok: false, reason: 'no-session' })
    expect(updateChatSessionMock).not.toHaveBeenCalled()
    expect(abortInflight).not.toHaveBeenCalled()
    expect(onStarted).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
  })

  test('2. empty session (messageCount=0) → {ok:false, reason:empty}; nothing called', async () => {
    const { wrapper } = makeWrapper()
    const abortInflight = vi.fn()
    const onStarted = vi.fn()
    const { result } = renderHook(
      () => useStartNewChat(baseArgs({ messageCount: 0, abortInflight, onStarted })),
      { wrapper },
    )

    const outcome = await result.current.mutateAsync()

    expect(outcome).toEqual({ ok: false, reason: 'empty' })
    expect(updateChatSessionMock).not.toHaveBeenCalled()
    expect(abortInflight).not.toHaveBeenCalled()
    expect(onStarted).not.toHaveBeenCalled()
    expect(alertSpy).not.toHaveBeenCalled()
  })

  test('3. abortInflight runs BEFORE updateChatSession when ready to archive', async () => {
    const { wrapper } = makeWrapper()
    const callOrder: string[] = []
    const abortInflight = vi.fn(() => callOrder.push('abort'))
    updateChatSessionMock.mockImplementation(async () => {
      callOrder.push('update')
      return { ok: true, session: { id: 'sess_abc' } }
    })
    const { result } = renderHook(
      () => useStartNewChat(baseArgs({ abortInflight })),
      { wrapper },
    )

    await result.current.mutateAsync()

    expect(callOrder).toEqual(['abort', 'update'])
  })

  test('4. 200 OK → {ok:true}; both queryKeys invalidated; onStarted fired; no alert', async () => {
    const { wrapper, qc } = makeWrapper()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const onStarted = vi.fn()
    updateChatSessionMock.mockResolvedValueOnce({ ok: true, session: { id: 'sess_abc' } })

    const { result } = renderHook(
      () => useStartNewChat(baseArgs({ onStarted })),
      { wrapper },
    )

    const outcome = await result.current.mutateAsync()

    expect(outcome).toEqual({ ok: true })
    expect(updateChatSessionMock).toHaveBeenCalledWith('sess_abc', { isArchived: true })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['chat', 'session-by-context', 'crm', 'crm:global'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['chat', 'sessions-list'] })
    expect(onStarted).toHaveBeenCalledTimes(1)
    expect(alertSpy).not.toHaveBeenCalled()
  })

  test('5. 409 conflict → {ok:false, reason:conflict}; NO invalidation; Alert.alert fired once', async () => {
    const { wrapper, qc } = makeWrapper()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    updateChatSessionMock.mockResolvedValueOnce({ ok: false, conflict: { id: 'sess_abc' } })

    const { result } = renderHook(() => useStartNewChat(baseArgs()), { wrapper })

    const outcome = await result.current.mutateAsync()

    expect(outcome).toEqual({ ok: false, reason: 'conflict' })
    expect(invalidateSpy).not.toHaveBeenCalled()
    // Alert.alert fires from onSuccess (mutationFn returns outcome, not throws).
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(alertSpy.mock.calls[0]?.[0]).toBe('Could not start a new chat')
  })

  test('6. updateChatSession rejects (network) → {ok:false, reason:network, message}; Alert fired', async () => {
    const { wrapper, qc } = makeWrapper()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    updateChatSessionMock.mockRejectedValueOnce(new Error('wifi gone'))

    const { result } = renderHook(() => useStartNewChat(baseArgs()), { wrapper })

    const outcome = await result.current.mutateAsync()

    expect(outcome).toEqual({
      ok: false,
      reason: 'network',
      message: 'wifi gone',
    })
    expect(invalidateSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(alertSpy.mock.calls[0]?.[0]).toBe('Could not start a new chat')
  })
})
