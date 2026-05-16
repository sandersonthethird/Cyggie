// @vitest-environment jsdom
/**
 * Tests for AddOptionInlineInput.
 *
 * Coverage:
 *   - Enter with non-empty draft → onConfirm called with trimmed value
 *   - Enter with whitespace-only draft → neither onConfirm nor onCancel called
 *   - Escape → onCancel called
 *   - Blur with non-empty draft → onConfirm called (commit-on-blur)
 *   - Blur with whitespace-only draft → onCancel called, onConfirm NOT called
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const { AddOptionInlineInput } = await import('../renderer/components/crm/AddOptionInlineInput')

afterEach(() => cleanup())

function setup() {
  const onConfirm = vi.fn().mockResolvedValue(undefined)
  const onCancel = vi.fn()
  const utils = render(
    <AddOptionInlineInput className="" onConfirm={onConfirm} onCancel={onCancel} />,
  )
  const input = utils.container.querySelector('input')!
  return { input, onConfirm, onCancel, ...utils }
}

describe('AddOptionInlineInput', () => {
  it('Enter with non-empty draft calls onConfirm with trimmed value', async () => {
    const { input, onConfirm, onCancel } = setup()
    fireEvent.change(input, { target: { value: '  candidate  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    // Allow the async onConfirm to resolve
    await new Promise((r) => setTimeout(r, 0))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('candidate')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Enter with whitespace-only draft does nothing', () => {
    const { input, onConfirm, onCancel } = setup()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Escape calls onCancel and not onConfirm', () => {
    const { input, onConfirm, onCancel } = setup()
    fireEvent.change(input, { target: { value: 'candidate' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Blur with non-empty draft commits via onConfirm', () => {
    const { input, onConfirm, onCancel } = setup()
    fireEvent.change(input, { target: { value: '  engineer  ' } })
    fireEvent.blur(input)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith('engineer')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('Blur with empty draft calls onCancel, not onConfirm', () => {
    const { input, onConfirm, onCancel } = setup()
    // No text entered
    fireEvent.blur(input)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Blur with whitespace-only draft calls onCancel, not onConfirm', () => {
    const { input, onConfirm, onCancel } = setup()
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
