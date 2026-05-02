// @vitest-environment jsdom
/**
 * Tests for InvestorChipsCell — read mode + popover lifecycle + key handling.
 *
 * Mock boundaries:
 *   - api.invoke      → controls IPC
 *   - useNavigate     → spy
 *   - CSS modules     → identity proxy
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

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

vi.mock('../renderer/components/crm/InvestorChipsCell.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))
vi.mock('../renderer/components/common/CompanyChip.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import { InvestorChipsCell } from '../renderer/components/crm/InvestorChipsCell'

const sampleValue = [
  { id: 'c1', name: 'Sequoia Capital', domain: 'sequoia.com' },
  { id: 'c2', name: 'Accel', domain: null },
]

function renderCell(overrides: Partial<Parameters<typeof InvestorChipsCell>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onStartEdit = vi.fn()
  const onEndEdit = vi.fn()
  const utils = render(
    <InvestorChipsCell
      value={overrides.value ?? sampleValue}
      onSave={overrides.onSave ?? onSave}
      isEditing={overrides.isEditing ?? false}
      onStartEdit={overrides.onStartEdit ?? onStartEdit}
      onEndEdit={overrides.onEndEdit ?? onEndEdit}
    />
  )
  return { ...utils, onSave, onStartEdit, onEndEdit }
}

describe('InvestorChipsCell — read mode', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue([])
    navigateMock.mockReset()
  })
  afterEach(() => cleanup())

  it('renders all chips when count ≤ 3', () => {
    renderCell({ value: sampleValue })
    expect(screen.getByText('Sequoia Capital')).toBeTruthy()
    expect(screen.getByText('Accel')).toBeTruthy()
  })

  it('shows "—" for empty value', () => {
    renderCell({ value: [] })
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('truncates with "+N more" when chips exceed 3', () => {
    const big = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: `Inv${i}`,
      domain: null,
    }))
    renderCell({ value: big })
    expect(screen.getByText('Inv0')).toBeTruthy()
    expect(screen.getByText('Inv1')).toBeTruthy()
    expect(screen.getByText('Inv2')).toBeTruthy()
    expect(screen.queryByText('Inv3')).toBeNull()
    expect(screen.getByText('+2 more')).toBeTruthy()
  })

  it('clicking a chip name navigates to /company/:id', () => {
    renderCell({ value: sampleValue })
    fireEvent.click(screen.getByText('Sequoia Capital'))
    expect(navigateMock).toHaveBeenCalledWith('/company/c1', expect.objectContaining({ state: { backLabel: 'Companies' } }))
  })

  it('double-click on cell triggers onStartEdit', () => {
    const { onStartEdit, container } = renderCell({ value: sampleValue })
    const cell = container.querySelector('[class*="cell"]')!
    fireEvent.doubleClick(cell)
    expect(onStartEdit).toHaveBeenCalled()
  })

  it('readOnly suppresses onStartEdit on double-click', () => {
    const onStartEdit = vi.fn()
    const onSave = vi.fn()
    const { container } = render(
      <InvestorChipsCell
        value={sampleValue}
        onSave={onSave}
        isEditing={false}
        onStartEdit={onStartEdit}
        onEndEdit={vi.fn()}
        readOnly
      />
    )
    const cell = container.querySelector('[class*="cell"]')!
    fireEvent.doubleClick(cell)
    expect(onStartEdit).not.toHaveBeenCalled()
  })
})

describe('InvestorChipsCell — popover lifecycle', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockResolvedValue([])
    navigateMock.mockReset()
  })
  afterEach(() => cleanup())

  it('shows popover input when isEditing=true', async () => {
    renderCell({ isEditing: true })
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/type a company or paste a list/i)).toBeTruthy()
    })
  })

  it('Escape calls onEndEdit', async () => {
    const { onEndEdit } = renderCell({ isEditing: true })
    const input = await screen.findByPlaceholderText(/type a company or paste a list/i)
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(onEndEdit).toHaveBeenCalled())
  })

  it('Backspace on empty input removes the last chip from the popover', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <InvestorChipsCell
        value={sampleValue}
        onSave={onSave}
        isEditing={true}
        onStartEdit={vi.fn()}
        onEndEdit={vi.fn()}
      />
    )
    const input = await screen.findByPlaceholderText(/type a company or paste a list/i)
    // 'Accel' appears in both read-mode cell + popover (2 instances)
    expect(screen.getAllByText('Accel').length).toBe(2)
    fireEvent.keyDown(input, { key: 'Backspace' })
    await waitFor(() => {
      // Backspace removes from chips state, which is shared between read-mode cell + popover
      expect(screen.queryByText('Accel')).toBeNull()
    })
  })
})
