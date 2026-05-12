// @vitest-environment jsdom
/**
 * Regression baseline for SearchBar keyboard navigation across grouped results.
 *
 * Why this exists: SearchBar flattens its categorized suggestions into
 * `flatItems` and arrow-key navigation walks that flat list. If a future
 * refactor (e.g. migrating to a shared listbox-navigation hook) silently
 * drops a category from the flatten step, the section still renders but
 * becomes unreachable by keyboard. This test asserts every category's
 * items participate in the keyboard cycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const invokeMock = vi.fn()
const navigateMock = vi.fn()
const setSearchParamsMock = vi.fn()

vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: vi.fn(() => () => {}),
  },
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'default' }),
  useSearchParams: () => [new URLSearchParams(), setSearchParamsMock],
}))

vi.mock('../renderer/components/common/SearchBar.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import SearchBar from '../renderer/components/common/SearchBar'

const SAMPLE_SUGGESTIONS = {
  people: ['Alice Person'],
  companies: [{ name: 'Acme Co', domain: 'acme.com' }],
  contacts: [{ id: 'c1', label: 'Bob Contact' }],
  meetings: [{ id: 'm1', title: 'Standup' }],
  notes: [{ id: 'n1', label: 'Note One' }],
  contentMatches: [
    { entityId: 'e1', entityType: 'meeting', title: 'Match Title', route: '/meeting/e1', snippet: 'snip', context: 'ctx' },
  ],
}

const ALL_LABELS = ['Alice Person', 'Acme Co', 'Bob Contact', 'Standup', 'Note One', 'Match Title']

function activeLabel(): string | null {
  const active = document.querySelector('[class*="suggestionActive"]')
  return active?.textContent?.trim().replace(/\s+/g, ' ') ?? null
}

async function setupOpenSuggestions() {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === 'search:all-speakers') return Promise.resolve([])
    if (channel === 'search:categorized') return Promise.resolve(SAMPLE_SUGGESTIONS)
    return Promise.resolve([])
  })
  render(<SearchBar />)
  const input = screen.getByPlaceholderText('Search meetings...') as HTMLInputElement
  // SearchBar requires query length >= 2 + a 150ms debounce
  await act(async () => {
    fireEvent.change(input, { target: { value: 'foo' } })
    await new Promise((r) => setTimeout(r, 200))
  })
  await waitFor(() => expect(screen.getByText('Alice Person')).toBeTruthy())
  return input
}

describe('SearchBar — keyboard navigation across grouped results', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    navigateMock.mockReset()
    setSearchParamsMock.mockReset()
  })
  afterEach(() => cleanup())

  it('renders every category section when results contain all types', async () => {
    await setupOpenSuggestions()
    for (const label of ALL_LABELS) {
      expect(screen.getByText(label), `expected "${label}" to be visible`).toBeTruthy()
    }
  })

  it('ArrowDown walks through every category in flatten order', async () => {
    const input = await setupOpenSuggestions()
    // Initial state: nothing active until the first ArrowDown.
    expect(activeLabel()).toBeNull()

    for (const expected of ALL_LABELS) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      const got = activeLabel()
      expect(got, `after walking to "${expected}", got "${got}"`).toContain(expected)
    }
  })

  it('Enter on the active item dispatches selection', async () => {
    const input = await setupOpenSuggestions()
    // Walk to "Standup" (a meeting — straightforward navigation target).
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Alice
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Acme
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Bob
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Standup
    expect(activeLabel()).toContain('Standup')
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/meeting/m1')
    })
  })

  it('Escape closes the suggestions panel', async () => {
    const input = await setupOpenSuggestions()
    expect(screen.queryByText('Alice Person')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByText('Alice Person')).toBeNull()
    })
  })
})
