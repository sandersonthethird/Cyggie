// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

// Build a minimal in-memory pref store for the hook to read/write through.
const memory = new Map<string, unknown>()
const getJSON = vi.fn((k: string, fallback: unknown) =>
  memory.has(k) ? memory.get(k) : fallback,
)
const setJSON = vi.fn((k: string, v: unknown) => { memory.set(k, v) })

vi.mock('../renderer/stores/preferences.store', () => ({
  usePreferencesStore: () => ({ getJSON, setJSON }),
}))

const { useSectionCollapse } = await import('../renderer/hooks/useSectionCollapse')

beforeEach(() => {
  memory.clear()
  getJSON.mockClear()
  setJSON.mockClear()
})

afterEach(() => cleanup())

describe('useSectionCollapse', () => {
  it('starts with no sections collapsed', () => {
    const { result } = renderHook(() => useSectionCollapse('company', 'co-1'))
    expect(result.current.isCollapsed('overview')).toBe(false)
    expect(result.current.collapsedKeys).toEqual([])
  })

  it('toggle adds key on first call, removes on second', () => {
    const { result, rerender } = renderHook(() => useSectionCollapse('company', 'co-1'))
    act(() => result.current.toggle('overview'))
    rerender()
    expect(result.current.isCollapsed('overview')).toBe(true)

    act(() => result.current.toggle('overview'))
    rerender()
    expect(result.current.isCollapsed('overview')).toBe(false)
  })

  it('persists per-entity scoped to id', () => {
    const a = renderHook(() => useSectionCollapse('company', 'co-1'))
    act(() => a.result.current.toggle('financials'))

    const b = renderHook(() => useSectionCollapse('company', 'co-2'))
    expect(b.result.current.isCollapsed('financials')).toBe(false)

    a.rerender()
    expect(a.result.current.isCollapsed('financials')).toBe(true)
  })

  it('persists per-entity-type scoped (company vs contact)', () => {
    const co = renderHook(() => useSectionCollapse('company', 'shared-id'))
    act(() => co.result.current.toggle('overview'))

    const ct = renderHook(() => useSectionCollapse('contact', 'shared-id'))
    expect(ct.result.current.isCollapsed('overview')).toBe(false)
  })

  it('writes to the correct storage key', () => {
    const { result } = renderHook(() => useSectionCollapse('contact', 'ct-99'))
    act(() => result.current.toggle('investor_info'))
    expect(setJSON).toHaveBeenCalledWith('cyggie:contact-collapsed:ct-99', ['investor_info'])
  })
})
