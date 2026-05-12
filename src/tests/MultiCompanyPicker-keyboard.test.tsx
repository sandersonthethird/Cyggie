// @vitest-environment jsdom
/**
 * Behavior-at-risk test for MultiCompanyPicker after the keyboard refactor.
 *
 * The site intercepts Enter to preserve a special "top-hit prefix-match
 * auto-add" behavior — when the highlighted suggestion is the first one AND
 * the typed input is a normalized prefix of its name (≥3 chars), Enter
 * adds the existing suggestion rather than running findOrCreate. This test
 * pins that behavior so future hook changes don't accidentally route Enter
 * through the hook's onSelect path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const invokeMock = vi.fn()
const navigateMock = vi.fn()

vi.mock('../renderer/api', () => ({
  api: {
    invoke: (...args: unknown[]) => invokeMock(...args),
    on: vi.fn(() => () => {}),
  },
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}))

vi.mock('../renderer/components/crm/MultiCompanyPicker.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))
vi.mock('../renderer/components/common/CompanyChip.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import { MultiCompanyPicker } from '../renderer/components/crm/MultiCompanyPicker'

describe('MultiCompanyPicker — keyboard behavior preservation', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    navigateMock.mockReset()
  })
  afterEach(() => cleanup())

  it('Enter on prefix-matching top hit auto-adds the existing suggestion (NOT findOrCreate)', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'company:list') {
        return Promise.resolve([
          { id: 'seq', canonicalName: 'Sequoia Capital', primaryDomain: 'sequoia.com' },
          { id: 'sef', canonicalName: 'Sefton Ventures', primaryDomain: null },
        ])
      }
      // findOrCreate would route here — test asserts it is NOT called.
      return Promise.resolve(null)
    })

    const onChange = vi.fn()
    render(<MultiCompanyPicker value={[]} onChange={onChange} />)

    fireEvent.click(screen.getByText(/\+ Add company/i))
    const input = await screen.findByPlaceholderText(/Search or type a name/i)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'Sequ' } })
      // usePicker debounces 250ms internally
      await new Promise((r) => setTimeout(r, 350))
    })
    await waitFor(() => expect(screen.getByText('Sequoia Capital')).toBeTruthy())

    // Enter without arrowing — activeIndex starts at 0, "Sequ" is a prefix
    // of "Sequoia Capital", length 4 ≥ 3 → top-hit auto-add path.
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        { id: 'seq', name: 'Sequoia Capital', domain: 'sequoia.com' },
      ])
    })

    // findOrCreate was NOT called — top-hit short-circuits before it.
    const findOrCreateCalls = invokeMock.mock.calls.filter(
      (c) => c[0] === 'company:find-or-create'
    )
    expect(findOrCreateCalls).toHaveLength(0)
  })

  it('ArrowDown then Enter on a non-top-hit suggestion adds that one', async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'company:list') {
        return Promise.resolve([
          { id: 'a', canonicalName: 'Alpha', primaryDomain: null },
          { id: 'b', canonicalName: 'Bravo', primaryDomain: null },
        ])
      }
      // The non-top-hit path falls through to commitInput, which on no exact
      // / fuzzy match calls findOrCreate. Stub it so the typed string resolves.
      if (channel === 'company:find-or-create') {
        return Promise.resolve({ id: 'created', canonicalName: 'xyz', primaryDomain: null })
      }
      return Promise.resolve(null)
    })

    const onChange = vi.fn()
    render(<MultiCompanyPicker value={[]} onChange={onChange} />)

    fireEvent.click(screen.getByText(/\+ Add company/i))
    const input = await screen.findByPlaceholderText(/Search or type a name/i)

    await act(async () => {
      fireEvent.change(input, { target: { value: 'xyz' } })
      await new Promise((r) => setTimeout(r, 350))
    })
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy())

    // ArrowDown moves activeIndex to 1 (Bravo). Bravo is NOT a prefix-match
    // of "xyz" → top-hit auto-add does not fire → falls through to commitInput
    // → no exact, no fuzzy → findOrCreate path.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        { id: 'created', name: 'xyz', domain: null },
      ])
    })
  })
})
