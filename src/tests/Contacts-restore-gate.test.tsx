// @vitest-environment jsdom
/**
 * Anti-flash gate wiring for the Contacts route.
 *
 * The bug: entering Contacts from the sidebar with a saved Type filter briefly
 * showed the FULL unfiltered list before the filter was restored. The fix gates
 * the table on useLastView's `restorePending` — while a saved-view restore is in
 * flight (URL still bare), the table is fed empty rows + loading so the
 * unfiltered list can never render for a frame.
 *
 * This pins the WIRING deterministically (no render-timing flakiness): with
 * `restorePending = true`, the table receives NO rows + loading even though the
 * data fetch returned contacts; flip it to false and the rows appear.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const invokeMock = vi.fn()
const gate = vi.hoisted(() => ({ restorePending: true }))
const tableSpy = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: vi.fn(() => () => {}),
  },
}))

// Control the gate directly; the hook's own logic is covered in useLastView.test.ts.
vi.mock('../renderer/hooks/useLastView', () => ({
  useLastView: () => ({ restorePending: gate.restorePending }),
}))

// Feature flag enabled so the route renders its table branch.
vi.mock('../renderer/hooks/useFeatureFlags', () => ({
  useFeatureFlag: () => ({ enabled: true, loading: false }),
  useFeatureFlags: () => ({ flags: {}, loading: false }),
}))

// Capture the props the table is rendered with instead of rendering the real grid.
vi.mock('../renderer/components/contact/ContactTable', () => ({
  ContactTable: (props: Record<string, unknown>) => {
    tableSpy.props = props
    return null
  },
}))

import Contacts from '../renderer/routes/Contacts'

const SAMPLE_CONTACTS = [
  { id: 'c1', fullName: 'Ann Founder', contactType: 'founder', email: 'ann@x.com' },
  { id: 'c2', fullName: 'Bo Investor', contactType: 'investor', email: 'bo@x.com' },
]

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'contact:list') return Promise.resolve(SAMPLE_CONTACTS)
    return Promise.resolve(null)
  })
  tableSpy.props = null
  gate.restorePending = true
  cleanup()
})

describe('Contacts — restore-pending gate', () => {
  it('feeds the table empty rows + loading while restorePending, even after data loads', async () => {
    gate.restorePending = true
    render(
      <MemoryRouter initialEntries={['/contacts']}>
        <Contacts />
      </MemoryRouter>,
    )

    // Let the contact fetch resolve so contacts state is populated.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('contact:list', expect.anything()))
    await waitFor(() => expect(tableSpy.props).not.toBeNull())

    // Gated: no rows reach the table and it's in loading state, despite the
    // fetch having returned contacts.
    expect((tableSpy.props!.contacts as unknown[]).length).toBe(0)
    expect(tableSpy.props!.loading).toBe(true)
  })

  it('passes the loaded contacts through once restorePending is false', async () => {
    gate.restorePending = false
    render(
      <MemoryRouter initialEntries={['/contacts']}>
        <Contacts />
      </MemoryRouter>,
    )

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('contact:list', expect.anything()))
    await waitFor(() => expect((tableSpy.props?.contacts as unknown[] | undefined)?.length).toBe(SAMPLE_CONTACTS.length))
    expect(tableSpy.props!.loading).toBe(false)
  })
})
