// @vitest-environment jsdom
/**
 * EnhancementContext — survives-navigation tests.
 *
 * The provider exists so that summary-enhancement state outlives the
 * MeetingDetail route. These tests don't render MeetingDetail; they
 * exercise the provider directly via useEnhancement and prove:
 *
 *   1. A consumer that mounts AFTER completion still gets the result
 *      (auto-open-on-return).
 *   2. consumePendingResult is take-once — a second consumer (e.g. a
 *      later re-mount) sees null and does not re-open the dialog.
 *   3. Streaming chunks and phase updates flow through subscribers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import React from 'react'

// Stub the api module — capture the channel→handler map so tests can
// fire fake IPC events synchronously, and control invoke resolution.
vi.mock('../renderer/api', () => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const invoke = vi.fn()
  return {
    api: {
      invoke,
      on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
        ;(handlers[channel] ??= []).push(cb)
        return () => {
          handlers[channel] = (handlers[channel] ?? []).filter((h) => h !== cb)
        }
      }),
    },
    // Exposed for tests to drive events into the provider
    __handlers: handlers,
  }
})

const { EnhancementProvider, useEnhancement } = await import(
  '../renderer/contexts/EnhancementContext'
)
const apiModule = (await import('../renderer/api')) as unknown as {
  api: { invoke: ReturnType<typeof vi.fn> }
  __handlers: Record<string, ((...args: unknown[]) => void)[]>
}
const { IPC_CHANNELS } = await import('../shared/constants/channels')

const MEETING_ID = 'meeting-X'
const TEMPLATE_ID = 'tpl-1'

function makeResult(overrides: Partial<{ summary: string }> = {}) {
  return {
    summary: overrides.summary ?? '# Summary',
    companyUpdateProposals: [],
    contactUpdateProposals: [],
  }
}

/**
 * Test rig that surfaces the hook's current state and bound actions on
 * a ref so tests can read/invoke them imperatively without re-rendering
 * dance.
 */
function makeProbe() {
  type Probe = {
    state: ReturnType<typeof useEnhancement>['state']
    start: (templateId: string) => Promise<void>
    consume: () => unknown
    renderCount: number
  }
  const probe: Probe = {
    state: { inProgress: false, phase: '', streamedSummary: '', pendingResult: null },
    start: async () => {},
    consume: () => null,
    renderCount: 0,
  }
  function Consumer({ meetingId }: { meetingId: string | undefined }) {
    const e = useEnhancement(meetingId)
    probe.state = e.state
    probe.start = e.startEnhancement
    probe.consume = e.consumePendingResult
    probe.renderCount += 1
    return null
  }
  return { probe, Consumer }
}

beforeEach(() => {
  Object.keys(apiModule.__handlers).forEach((k) => delete apiModule.__handlers[k])
  apiModule.api.invoke.mockReset()
})

describe('EnhancementContext', () => {
  it('serves a late-mounted child the pending result from the same provider', async () => {
    const result = makeResult({ summary: 'Late-mount payload' })
    apiModule.api.invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SUMMARY_GENERATE) return Promise.resolve(result)
      return Promise.resolve(undefined)
    })

    const { probe: early, Consumer: EarlyConsumer } = makeProbe()
    const { probe: late, Consumer: LateConsumer } = makeProbe()

    function App({ mountLate }: { mountLate: boolean }) {
      return React.createElement(
        EnhancementProvider,
        null,
        React.createElement(EarlyConsumer, { meetingId: MEETING_ID }),
        mountLate ? React.createElement(LateConsumer, { meetingId: MEETING_ID }) : null,
      )
    }

    const { rerender } = render(React.createElement(App, { mountLate: false }))

    // Early consumer triggers enhancement and waits for it to land
    await act(async () => {
      await early.start(TEMPLATE_ID)
    })

    expect(early.state.pendingResult).toEqual(result)

    // Now the "late-mounted" consumer joins — same provider instance,
    // so it sees the same shared state via its own subscription read.
    rerender(React.createElement(App, { mountLate: true }))

    expect(late.state.pendingResult).toEqual(result)
  })

  it('consumePendingResult is take-once — a second call returns null', async () => {
    const result = makeResult({ summary: 'Take-once' })
    apiModule.api.invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SUMMARY_GENERATE) return Promise.resolve(result)
      return Promise.resolve(undefined)
    })

    const { probe, Consumer } = makeProbe()
    render(
      React.createElement(
        EnhancementProvider,
        null,
        React.createElement(Consumer, { meetingId: MEETING_ID }),
      ),
    )

    await act(async () => {
      await probe.start(TEMPLATE_ID)
    })

    const first = probe.consume()
    expect(first).toEqual(result)

    const second = probe.consume()
    expect(second).toBeNull()
  })

  it('routes SUMMARY_PROGRESS chunks into the active meeting and notifies subscribers', async () => {
    // Hold SUMMARY_GENERATE unresolved so streaming events can arrive mid-flight.
    let resolveInvoke!: (value: unknown) => void
    apiModule.api.invoke.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SUMMARY_GENERATE) {
        return new Promise((r) => { resolveInvoke = r })
      }
      return Promise.resolve(undefined)
    })

    const { probe, Consumer } = makeProbe()
    render(
      React.createElement(
        EnhancementProvider,
        null,
        React.createElement(Consumer, { meetingId: MEETING_ID }),
      ),
    )

    // Kick off start(). The async function runs synchronously up to
    // `await api.invoke(...)`, which sets activeMeetingIdRef and flips
    // inProgress. We don't await the returned promise (it'd hang).
    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = probe.start(TEMPLATE_ID)
      await Promise.resolve()
    })
    expect(probe.state.inProgress).toBe(true)

    // Fire two streaming chunks
    await act(async () => {
      apiModule.__handlers[IPC_CHANNELS.SUMMARY_PROGRESS]?.forEach((cb) => cb('Hello, '))
      apiModule.__handlers[IPC_CHANNELS.SUMMARY_PROGRESS]?.forEach((cb) => cb('world'))
    })
    expect(probe.state.streamedSummary).toBe('Hello, world')

    // Null chunk = phase reset; buffer clears
    await act(async () => {
      apiModule.__handlers[IPC_CHANNELS.SUMMARY_PROGRESS]?.forEach((cb) => cb(null))
    })
    expect(probe.state.streamedSummary).toBe('')

    // Phase events land on the active meeting
    await act(async () => {
      apiModule.__handlers[IPC_CHANNELS.SUMMARY_PHASE]?.forEach((cb) => cb('refining'))
    })
    expect(probe.state.phase).toBe('refining')

    // Resolve invoke + drain so the in-flight promise settles cleanly.
    await act(async () => {
      resolveInvoke(makeResult())
      await startPromise
    })
  })
})
