// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import React from 'react'

// ─── Mock css modules and child components ────────────────────────────────────

vi.mock('../renderer/components/crm/PropertyRow.module.css', () => ({ default: {} }))
vi.mock('../renderer/components/crm/AddOptionInlineInput', () => ({
  AddOptionInlineInput: () => null,
}))
vi.mock('../renderer/components/crm/EntitySearch', () => ({
  EntitySearch: () => null,
}))
vi.mock('../renderer/api', () => ({
  api: { invoke: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../renderer/utils/colorChip', () => ({
  chipStyle: () => ({}),
}))
vi.mock('../renderer/utils/format', () => ({
  formatCurrency: (v: number) => String(v),
  formatDate: (v: string) => v,
}))

const { PropertyRow } = await import('../renderer/components/crm/PropertyRow')

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

// ── Bug #2: race condition re-trigger ─────────────────────────────────────────
//
// If editValue changes while an IPC save is in-flight (saving=true), the pending
// change is tracked via editValueRef. When the IPC resolves, the finally block
// detects the mismatch and re-triggers handleSave with the latest value.
//
// Flow:
//   handleSave('Hello')  →  saving=true, IPC in-flight
//   setEditValue('Hello World')  →  editValueRef updated, saving still true
//   IPC resolves  →  finally: editValueRef.current('Hello World') !== val('Hello')
//                →  setTimeout(handleSave('Hello World'), 0)

describe('PropertyRow — Bug #2 race condition re-trigger', () => {
  it('re-triggers save when editValue changes while IPC is in-flight', async () => {
    let resolveFirstSave!: () => void
    const firstSavePromise = new Promise<void>((res) => { resolveFirstSave = res })

    const onSave = vi.fn()
      .mockImplementationOnce(() => firstSavePromise)   // first call: holds
      .mockResolvedValue(undefined)                     // second call: resolves immediately

    const { getByRole } = render(
      React.createElement(PropertyRow, {
        label: 'Name',
        value: 'initial',
        type: 'text' as const,
        onSave,
        editMode: true,
      }),
    )

    const input = getByRole('textbox')

    // Advance past initial debounce so first render doesn't trigger auto-save
    await act(async () => { vi.advanceTimersByTime(400) })

    // User types 'Hello' — debounce triggers after 300ms
    fireEvent.change(input, { target: { value: 'Hello' } })
    await act(async () => { vi.advanceTimersByTime(300) })

    // handleSave('Hello') is now in-flight; onSave called once
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith('Hello')

    // While in-flight: user types 'Hello World'
    // saving=true so handleSave is a no-op, but editValueRef is updated
    fireEvent.change(input, { target: { value: 'Hello World' } })
    await act(async () => { vi.advanceTimersByTime(300) })

    // Still only one call (second debounce hit saving=true guard)
    expect(onSave).toHaveBeenCalledTimes(1)

    // Resolve the first save
    await act(async () => { resolveFirstSave() })

    // finally block runs: editValueRef('Hello World') !== val('Hello') → re-trigger after 0ms
    await act(async () => { vi.advanceTimersByTime(0) })

    // Second save should have been called with the pending value
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(onSave).toHaveBeenNthCalledWith(2, 'Hello World')
  })
})

// ── Bug #3: inline edit stays open after debounced auto-save ─────────────────
//
// When a user clicks a url/text field to enter inline edit mode (editing=true,
// editMode=false), the debounced auto-save must NOT call setEditing(false).
//
// Flow:
//   user clicks → editing=true → types URL
//   debounce fires (300ms) → handleSave(val, keepEditing=true)
//   save succeeds → editing stays true → input remains in DOM

describe('PropertyRow — inline edit stays open after debounced auto-save', () => {
  it('keeps the input mounted after debounced save fires', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)

    const { container, getByRole, queryByRole } = render(
      React.createElement(PropertyRow, {
        label: 'Website',
        value: '',
        type: 'url' as const,
        onSave,
      }),
    )

    // Advance past initial debounce to ensure no spurious auto-save on mount
    await act(async () => { vi.advanceTimersByTime(400) })

    // Click the row div to enter inline edit mode (no button role — it's a plain div)
    fireEvent.click(container.firstChild as Element)

    // Input should now be present
    expect(getByRole('textbox')).toBeTruthy()

    // Type a partial URL
    fireEvent.change(getByRole('textbox'), { target: { value: 'https://' } })

    // Let debounce fire → handleSave('https://', keepEditing=true)
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(onSave).toHaveBeenCalledWith('https://')

    // Input must still be in the DOM — editing was NOT closed
    expect(queryByRole('textbox')).not.toBeNull()
  })

  it('closes inline editing on blur', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)

    const { container, getByRole, queryByRole } = render(
      React.createElement(PropertyRow, {
        label: 'Website',
        value: '',
        type: 'url' as const,
        onSave,
      }),
    )

    await act(async () => { vi.advanceTimersByTime(400) })

    // Enter inline edit
    fireEvent.click(container.firstChild as Element)
    const input = getByRole('textbox')
    fireEvent.change(input, { target: { value: 'https://example.com' } })

    // Blur the input — should close editing
    await act(async () => { fireEvent.blur(input) })

    expect(queryByRole('textbox')).toBeNull()
  })
})

// ── Bug #2: mounted guard ────────────────────────────────────────────────────
//
// If the component unmounts while a save is in-flight, the finally block
// should bail out early (mountedRef.current = false) to prevent setState
// calls on an unmounted component.

describe('PropertyRow — mounted guard', () => {
  it('does not throw or call setState after unmount during in-flight save', async () => {
    let resolveFirstSave!: () => void
    const firstSavePromise = new Promise<void>((res) => { resolveFirstSave = res })
    const onSave = vi.fn().mockImplementationOnce(() => firstSavePromise)

    const { getByRole, unmount } = render(
      React.createElement(PropertyRow, {
        label: 'Name',
        value: 'initial',
        type: 'text' as const,
        onSave,
        editMode: true,
      }),
    )

    const input = getByRole('textbox')

    // Trigger save via debounce
    fireEvent.change(input, { target: { value: 'New Value' } })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(onSave).toHaveBeenCalledTimes(1)

    // Unmount while save is in-flight
    unmount()

    // Resolve the promise — finally block should bail on mountedRef check, no errors
    await act(async () => { resolveFirstSave() })

    // No setState calls happen → no "Can't perform a React state update on unmounted" warning
    // (Absence of throw/console.error is the assertion here)
    await act(async () => { vi.advanceTimersByTime(0) })

    // onSave was only called once; no re-trigger after unmount
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
