// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// ─── Mock api.invoke ──────────────────────────────────────────────────────────

const mockInvoke = vi.fn()

vi.mock('../renderer/api', () => ({
  api: { invoke: (...args: unknown[]) => mockInvoke(...args) }
}))

const { useCustomFieldValues } = await import('../renderer/hooks/useCustomFieldValues')

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  mockInvoke.mockResolvedValue({ success: true, data: {} })
})

describe('useCustomFieldValues', () => {
  it('does not call IPC when no custom keys are visible', async () => {
    const { result } = renderHook(() =>
      useCustomFieldValues('company', ['name', 'sector'], 5)
    )

    await waitFor(() => {
      expect(mockInvoke).not.toHaveBeenCalled()
    })
    expect(result.current.values).toEqual({})
  })

  it('calls IPC with correct entityType and extracted defIds', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      data: { 'co-1': { 'def-abc': 'B2B' } }
    })

    const { result } = renderHook(() =>
      useCustomFieldValues('company', ['name', 'custom:def-abc'], 3)
    )

    await waitFor(() =>
      expect(result.current.values).toEqual({ 'co-1': { 'def-abc': 'B2B' } })
    )
    expect(mockInvoke).toHaveBeenCalledWith(
      'custom-field:get-bulk-values',
      'company',
      ['def-abc']
    )
  })

  it('warns and leaves values unchanged when IPC returns success: false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockInvoke.mockResolvedValue({ success: false })

    const { result } = renderHook(() =>
      useCustomFieldValues('company', ['custom:def-xyz'], 2)
    )

    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    expect(result.current.values).toEqual({})
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[customFields]'),
      expect.anything()
    )
    warnSpy.mockRestore()
  })

  it('patch updates values optimistically without IPC', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      data: { 'co-1': { 'def-1': 'Old' } }
    })

    const { result } = renderHook(() =>
      useCustomFieldValues('company', ['custom:def-1'], 1)
    )

    await waitFor(() => expect(result.current.values['co-1']?.['def-1']).toBe('Old'))

    const invocationsBeforePatch = mockInvoke.mock.calls.length

    act(() => {
      result.current.patch('co-1', 'def-1', 'B2B')
    })

    expect(result.current.values['co-1']['def-1']).toBe('B2B')
    // No additional IPC calls from patch
    expect(mockInvoke).toHaveBeenCalledTimes(invocationsBeforePatch)
  })

  it('patch stores empty string when value is null', () => {
    const { result } = renderHook(() =>
      useCustomFieldValues('company', ['custom:def-1'], 0)
    )

    act(() => {
      result.current.patch('co-1', 'def-1', null)
    })

    expect(result.current.values['co-1']['def-1']).toBe('')
  })

  it('patch creates nested object for new entityId', () => {
    const { result } = renderHook(() =>
      useCustomFieldValues('company', ['custom:def-1'], 0)
    )

    act(() => {
      result.current.patch('co-new', 'def-1', 'SaaS')
    })

    expect(result.current.values['co-new']['def-1']).toBe('SaaS')
  })

  it('refetches when rowCount changes', async () => {
    mockInvoke.mockResolvedValue({ success: true, data: {} })

    const { rerender } = renderHook(
      ({ count }: { count: number }) =>
        useCustomFieldValues('company', ['custom:def-1'], count),
      { initialProps: { count: 1 } }
    )

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1))

    rerender({ count: 2 })

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2))
  })

  it('refetches when visible custom columns change', async () => {
    mockInvoke.mockResolvedValue({ success: true, data: {} })

    const { rerender } = renderHook(
      ({ keys }: { keys: string[] }) =>
        useCustomFieldValues('company', keys, 1),
      { initialProps: { keys: ['custom:def-1'] } }
    )

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1))

    rerender({ keys: ['custom:def-1', 'custom:def-2'] })

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(2))
  })
})
