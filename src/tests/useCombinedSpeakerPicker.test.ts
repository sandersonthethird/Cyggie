// @vitest-environment jsdom
/**
 * Tests for useCombinedSpeakerPicker — the adapter hook that lets
 * EntityPicker render calendar attendees (in-memory, filtered client-side)
 * alongside CRM contacts (IPC-backed) in one dropdown.
 *
 * Coverage:
 *   - empty attendees → results contain only contacts
 *   - non-empty attendees + non-empty contacts → attendees first, then contacts
 *   - typing filters attendees client-side (substring match, case-insensitive)
 *   - typing also forwards the query to the IPC search
 *   - the first attendee and the first contact are flagged isSectionLead
 *   - id collision-safety: attendee ids carry the `attendee:` prefix
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import type { ContactSummary } from '../shared/types/contact'

const invokeMock = vi.fn()
vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => invokeMock(...args) },
}))

const { useCombinedSpeakerPicker } = await import('../renderer/hooks/useCombinedSpeakerPicker')

// Drains the setTimeout(0) inside usePicker's debouncer + the Promise
// chain it awaits. Real timers (no useFakeTimers) so waitFor's polling
// works the way RTL expects.
async function flushPicker() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
}

function fakeContact(id: string, fullName: string): ContactSummary {
  return {
    id,
    fullName,
    firstName: fullName.split(' ')[0] ?? null,
    lastName: fullName.split(' ').slice(1).join(' ') || null,
    normalizedName: fullName.toLowerCase(),
    email: null,
    primaryCompanyId: null,
    primaryCompanyName: null,
    title: null,
    contactType: null,
    talentPipeline: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    meetingCount: 0,
    emailCount: 0,
    lastTouchpoint: null,
    createdAt: '',
    updatedAt: '',
  }
}

describe('useCombinedSpeakerPicker', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue([])
  })

  it('exposes attendees first, contacts second in the merged results', async () => {
    invokeMock.mockResolvedValueOnce([fakeContact('c1', 'Andy Smith')])
    const { result } = renderHook(() =>
      useCombinedSpeakerPicker(['Sandy Cass', 'Jamie Lin']),
    )

    act(() => {
      result.current.search('', 0)
    })
    await flushPicker()
    await waitFor(() => expect(result.current.searching).toBe(false))

    expect(result.current.results.map((r) => r.kind)).toEqual([
      'attendee',
      'attendee',
      'contact',
    ])
    expect(result.current.results[0]).toMatchObject({
      kind: 'attendee',
      name: 'Sandy Cass',
      isSectionLead: true,
    })
    expect(result.current.results[1]).toMatchObject({
      kind: 'attendee',
      name: 'Jamie Lin',
      isSectionLead: false,
    })
    expect(result.current.results[2]).toMatchObject({
      kind: 'contact',
      isSectionLead: true,
    })
  })

  it('returns contacts-only when attendees is empty', async () => {
    invokeMock.mockResolvedValueOnce([
      fakeContact('c1', 'Andy Smith'),
      fakeContact('c2', 'Dana Williams'),
    ])
    const { result } = renderHook(() => useCombinedSpeakerPicker([]))

    act(() => {
      result.current.search('', 0)
    })
    await flushPicker()
    await waitFor(() => expect(result.current.searching).toBe(false))

    expect(result.current.results.map((r) => r.kind)).toEqual(['contact', 'contact'])
    expect(result.current.results[0]).toMatchObject({ isSectionLead: true })
    expect(result.current.results[1]).toMatchObject({ isSectionLead: false })
  })

  it('filters attendees client-side by case-insensitive substring', async () => {
    invokeMock.mockResolvedValue([])
    const { result } = renderHook(() =>
      useCombinedSpeakerPicker(['Sandy Cass', 'Jamie Lin', 'Andy Smith']),
    )

    act(() => {
      result.current.search('SAN', 0)
    })
    await flushPicker()

    const attendeeNames = result.current.results
      .filter((r) => r.kind === 'attendee')
      .map((r) => (r.kind === 'attendee' ? r.name : ''))
    expect(attendeeNames).toEqual(['Sandy Cass'])
  })

  it('forwards the query to the IPC search', async () => {
    invokeMock.mockResolvedValue([])
    const { result } = renderHook(() => useCombinedSpeakerPicker([]))

    act(() => {
      result.current.search('jam', 0)
    })
    await flushPicker()

    expect(invokeMock).toHaveBeenCalled()
    const lastCall = invokeMock.mock.calls.at(-1)
    expect(lastCall?.[1]).toMatchObject({ query: 'jam' })
  })

  it('synthesizes attendee ids with the `attendee:` prefix', async () => {
    invokeMock.mockResolvedValue([])
    const { result } = renderHook(() => useCombinedSpeakerPicker(['Sandy Cass']))

    act(() => {
      result.current.search('', 0)
    })
    await flushPicker()

    expect(result.current.results[0]?.id).toBe('attendee:Sandy Cass')
  })
})
