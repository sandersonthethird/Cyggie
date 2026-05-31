// @vitest-environment jsdom
/**
 * OptionListPopover — shared dropdown primitive.
 *
 * Coverage:
 *   render        — options visible; current value highlighted; "+ Add option" gated on prop
 *   keyboard      — ArrowUp/Down moves active; Enter picks (single); Space toggles (multi);
 *                   Tab calls onPickAndAdvance; Escape closes; printable chars jump-to-prefix
 *   type-accumulator — multi-char prefix within 500ms; idle resets buffer
 *   outside-click — closes; does not pick
 *   add-option    — clicking "+ Add option…" swaps body to inline input (popover stays);
 *                   confirming calls onAddOptionConfirm
 *   stopPropagation — mousedown inside popover doesn't escape (double-click fallback safety)
 *   stale-closure regression — onPick(v) gives back the value the user clicked, not the prior `value` prop
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { CSSProperties } from 'react'

vi.mock('../renderer/components/crm/OptionListPopover.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import { OptionListPopover } from '../renderer/components/crm/OptionListPopover'

const OPTIONS = [
  { value: 'investor', label: 'Investor' },
  { value: 'founder',  label: 'Founder' },
  { value: 'operator', label: 'Operator' },
  { value: 'owner',    label: 'Owner' },
  { value: 'lp',       label: 'LP' },
]

function makeAnchor(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  // Fixed-position rect so positioning is deterministic.
  el.getBoundingClientRect = () => ({
    top: 100, bottom: 130, left: 100, right: 300,
    width: 200, height: 30, x: 100, y: 100, toJSON: () => ({}),
  })
  return el
}

function renderPopover(overrides: Partial<Parameters<typeof OptionListPopover>[0]> = {}) {
  const anchor = overrides.anchorEl ?? makeAnchor()
  const onClose = vi.fn()
  const onPick = vi.fn()
  const utils = render(
    <OptionListPopover
      anchorEl={anchor}
      options={overrides.options ?? OPTIONS}
      value={overrides.value ?? ''}
      mode={overrides.mode ?? 'single'}
      onClose={overrides.onClose ?? onClose}
      onPick={overrides.onPick ?? onPick}
      onPickAndAdvance={overrides.onPickAndAdvance}
      onMultiChange={overrides.onMultiChange}
      onCommitMulti={overrides.onCommitMulti}
      onAddOption={overrides.onAddOption}
      onAddOptionConfirm={overrides.onAddOptionConfirm}
      scrollContainer={overrides.scrollContainer}
      initialChar={overrides.initialChar}
      chipStyle={overrides.chipStyle}
    />
  )
  return { ...utils, anchor, onClose, onPick }
}

function getOptionRow(label: string): HTMLElement {
  return screen.getByText(label).closest('[role="option"]') as HTMLElement
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('OptionListPopover — render', () => {
  it('renders all options', () => {
    renderPopover()
    expect(screen.getByText('Investor')).toBeTruthy()
    expect(screen.getByText('Founder')).toBeTruthy()
    expect(screen.getByText('LP')).toBeTruthy()
  })

  it('renders chips when chipStyle is provided', () => {
    const chipStyle = (_v: string): CSSProperties => ({ background: 'rgb(255, 0, 0)' })
    renderPopover({ chipStyle })
    const investorChip = screen.getByText('Investor')
    expect(investorChip.style.background).toContain('rgb(255, 0, 0)')
  })

  it('does NOT render "+ Add option…" when onAddOption is not provided', () => {
    renderPopover()
    expect(screen.queryByText('+ Add option…')).toBeNull()
  })

  it('renders "+ Add option…" when onAddOption is provided', () => {
    renderPopover({ onAddOption: vi.fn() })
    expect(screen.getByText('+ Add option…')).toBeTruthy()
  })

  it('highlights the option matching `value` prop on mount (single mode)', () => {
    renderPopover({ value: 'founder' })
    // Founder option is at index 1; rely on aria-selected
    expect(getOptionRow('Founder').getAttribute('aria-selected')).toBe('true')
    expect(getOptionRow('Investor').getAttribute('aria-selected')).toBe('false')
  })

  it('shows checkboxes in multi mode', () => {
    renderPopover({ mode: 'multi', value: ['investor', 'operator'] })
    expect(getOptionRow('Investor').getAttribute('aria-selected')).toBe('true')
    expect(getOptionRow('Operator').getAttribute('aria-selected')).toBe('true')
    expect(getOptionRow('Founder').getAttribute('aria-selected')).toBe('false')
  })

  it('highlights first option starting with `initialChar` (case-insensitive)', () => {
    renderPopover({ initialChar: 'O' })
    // First O-option is "Operator" (index 2)
    // Simulate Enter to pick the highlighted item
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
  })
})

describe('OptionListPopover — keyboard navigation (single mode)', () => {
  it('ArrowDown + Enter picks the next option', () => {
    const onPick = vi.fn()
    const { anchor } = renderPopover({ value: 'investor', onPick })
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })  // → founder
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('founder')
    void anchor
  })

  it('ArrowUp wraps from first to last option', () => {
    const onPick = vi.fn()
    renderPopover({ value: 'investor', onPick })  // 5 options: investor, founder, operator, owner, lp
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'ArrowUp' })  // 0 → wrap → last (lp)
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('lp')
  })

  it('ArrowDown wraps from last to first option', () => {
    const onPick = vi.fn()
    renderPopover({ value: 'lp', onPick })  // active starts at 'lp' (last, index 4)
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })  // last → wrap → first (investor)
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('investor')
  })

  it('Tab calls onPickAndAdvance with active value and dir=right', () => {
    const onPickAndAdvance = vi.fn()
    renderPopover({ value: 'investor', onPickAndAdvance })
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })  // → founder
    fireEvent.keyDown(listbox, { key: 'Tab' })
    expect(onPickAndAdvance).toHaveBeenCalledWith('founder', 'right')
  })

  it('Shift+Tab calls onPickAndAdvance with dir=down', () => {
    const onPickAndAdvance = vi.fn()
    renderPopover({ value: 'investor', onPickAndAdvance })
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'Tab', shiftKey: true })
    expect(onPickAndAdvance).toHaveBeenCalledWith('investor', 'down')
  })

  it('Escape calls onClose (NOT onPick)', () => {
    const onPick = vi.fn()
    const onClose = vi.fn()
    renderPopover({ onPick, onClose })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('OptionListPopover — multi mode', () => {
  it('Space toggles selection; onMultiChange gets the new array; popover stays open', () => {
    const onMultiChange = vi.fn()
    const onClose = vi.fn()
    renderPopover({
      mode: 'multi',
      value: ['investor'],
      onMultiChange,
      onClose,
    })
    const listbox = screen.getByRole('listbox')
    // Space on the first item (Investor, index 0 from value) toggles selection off.
    fireEvent.keyDown(listbox, { key: ' ' })
    expect(onMultiChange).toHaveBeenCalledWith([])
    expect(onClose).not.toHaveBeenCalled()  // Space does NOT close
  })

  it('Enter in multi mode closes (commits accumulated selection); does not toggle', () => {
    const onMultiChange = vi.fn()
    const onCommitMulti = vi.fn()
    const onClose = vi.fn()
    renderPopover({
      mode: 'multi',
      value: ['investor'],
      onMultiChange,
      onCommitMulti,
      onClose,
    })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onMultiChange).not.toHaveBeenCalled()  // Enter doesn't toggle
    expect(onCommitMulti).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('clicking an option toggles selection (multi mode)', () => {
    const onMultiChange = vi.fn()
    renderPopover({
      mode: 'multi',
      value: [],
      onMultiChange,
    })
    fireEvent.click(getOptionRow('Founder'))
    expect(onMultiChange).toHaveBeenCalledWith(['founder'])
  })

  it('onCommitMulti fires on close', () => {
    const onCommitMulti = vi.fn()
    const onClose = vi.fn()
    renderPopover({
      mode: 'multi',
      value: ['investor'],
      onMultiChange: vi.fn(),
      onCommitMulti,
      onClose,
    })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onCommitMulti).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('OptionListPopover — type-to-jump accumulator', () => {
  it('multi-char prefix within 500ms jumps to "Operator" (disambiguates from "Owner")', () => {
    const onPick = vi.fn()
    renderPopover({ onPick })
    const listbox = screen.getByRole('listbox')
    // Two options start with "O": Operator, Owner
    fireEvent.keyDown(listbox, { key: 'o' })  // → first O = Operator
    fireEvent.keyDown(listbox, { key: 'p' })  // → typeBuf = 'op' → Operator stays
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('operator')
  })

  it('idle >500ms resets the buffer; next char starts fresh', () => {
    const onPick = vi.fn()
    renderPopover({ onPick })
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'o' })  // → Operator
    act(() => { vi.advanceTimersByTime(600) })  // buffer reset
    fireEvent.keyDown(listbox, { key: 'l' })  // → LP (fresh; not 'ol')
    fireEvent.keyDown(listbox, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('lp')
  })
})

describe('OptionListPopover — outside-click', () => {
  it('mousedown outside calls onClose, not onPick', () => {
    const onClose = vi.fn()
    const onPick = vi.fn()
    renderPopover({ onClose, onPick })
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    fireEvent.mouseDown(outside)
    expect(onClose).toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('mousedown on anchor does NOT close (anchor owns its own click semantics)', () => {
    const onClose = vi.fn()
    const anchor = makeAnchor()
    renderPopover({ anchorEl: anchor, onClose })
    fireEvent.mouseDown(anchor)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('mousedown inside popover stops propagation (double-click fallback safety)', () => {
    const onClose = vi.fn()
    renderPopover({ onClose })
    fireEvent.mouseDown(screen.getByRole('listbox'))
    // The handler ignores clicks inside popoverRef → onClose not called
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('OptionListPopover — add-option flow', () => {
  it('clicking "+ Add option…" swaps body to inline input (popover stays open)', () => {
    renderPopover({
      onAddOption: vi.fn(),
      onAddOptionConfirm: vi.fn(),
    })
    fireEvent.click(screen.getByText('+ Add option…'))
    // Inline input appears
    expect(screen.getByPlaceholderText('New option…')).toBeTruthy()
    // Listbox is still in the DOM (popover still mounted)
    expect(screen.queryByRole('listbox')).toBeTruthy()
    // Original options no longer rendered (body swapped)
    expect(screen.queryByText('Investor')).toBeNull()
  })

  it('confirming inline input calls onAddOptionConfirm with the typed value, then closes', async () => {
    const onAddOptionConfirm = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    renderPopover({
      onAddOption: vi.fn(),
      onAddOptionConfirm,
      onClose,
    })
    fireEvent.click(screen.getByText('+ Add option…'))
    const input = screen.getByPlaceholderText('New option…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'angel' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Allow the async confirm to flush
    await act(async () => { await Promise.resolve() })
    expect(onAddOptionConfirm).toHaveBeenCalledWith('angel')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('OptionListPopover — regression coverage', () => {
  it('REGRESSION (Issue 6): onPick receives the picked value, not the value prop', () => {
    // The plan's stale-closure bug: if onPick received the popover's
    // internally-tracked draft instead of the literal clicked option, this
    // would pass `value` ('founder') back instead of 'investor'.
    const onPick = vi.fn()
    renderPopover({ value: 'founder', onPick })
    fireEvent.click(getOptionRow('Investor'))
    expect(onPick).toHaveBeenCalledWith('investor')
    expect(onPick).not.toHaveBeenCalledWith('founder')
  })

  it('clicking an option in single mode calls onClose (popover dismisses)', () => {
    const onClose = vi.fn()
    renderPopover({ onClose })
    fireEvent.click(getOptionRow('Founder'))
    expect(onClose).toHaveBeenCalled()
  })

  it('returns null when anchorEl is null', () => {
    const { container } = render(
      <OptionListPopover
        anchorEl={null}
        options={OPTIONS}
        value=""
        mode="single"
        onClose={vi.fn()}
        onPick={vi.fn()}
      />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders "No options" when options array is empty', () => {
    renderPopover({ options: [] })
    expect(screen.getByText('No options')).toBeTruthy()
  })
})
