// @vitest-environment jsdom
/**
 * Tests for useInvestorChips — focused on parseList (the only deterministic,
 * non-IPC-coupled function on the hook). The other functions (search,
 * findOrCreate, fuzzyMatch) are thin wrappers over usePicker / IPC / fuzzyMatchExisting,
 * which are independently tested.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

vi.mock('../renderer/api', () => ({
  api: {
    invoke: vi.fn().mockResolvedValue([]),
    on: vi.fn(() => () => {}),
  },
}))

import { useInvestorChips } from '../renderer/hooks/useInvestorChips'

const noDomain = (id: string, name: string) => ({ id, name, domain: null })

describe('useInvestorChips.parseList', () => {
  it('splits on comma', () => {
    const { result } = renderHook(() => useInvestorChips())
    const out = result.current.parseList('Sequoia, Accel, Index', [])
    expect(out.names).toEqual(['Sequoia', 'Accel', 'Index'])
    expect(out.clamped).toBe(false)
  })

  it('splits on semicolon and newline and tab', () => {
    const { result } = renderHook(() => useInvestorChips())
    const out = result.current.parseList('A; B\nC\tD', [])
    expect(out.names).toEqual(['A', 'B', 'C', 'D'])
  })

  it('trims whitespace from names', () => {
    const { result } = renderHook(() => useInvestorChips())
    const out = result.current.parseList('  Sequoia  ,   Accel   ', [])
    expect(out.names).toEqual(['Sequoia', 'Accel'])
  })

  it('dedupes within the paste', () => {
    const { result } = renderHook(() => useInvestorChips())
    const out = result.current.parseList('A, A, b, B', [])
    expect(out.names).toEqual(['A', 'b']) // first occurrence wins, case-insensitive dedup
  })

  it('dedupes against existing chips', () => {
    const { result } = renderHook(() => useInvestorChips())
    const existing = [noDomain('c1', 'Sequoia')]
    const out = result.current.parseList('Sequoia, Accel', existing)
    expect(out.names).toEqual(['Accel'])
  })

  it('returns empty for empty input', () => {
    const { result } = renderHook(() => useInvestorChips())
    expect(result.current.parseList('', []).names).toEqual([])
  })

  it('returns empty for delimiter-only input', () => {
    const { result } = renderHook(() => useInvestorChips())
    expect(result.current.parseList(',,;;', []).names).toEqual([])
  })

  it('clamps to 25 names', () => {
    const { result } = renderHook(() => useInvestorChips())
    const names = Array.from({ length: 50 }, (_, i) => `Name${i}`).join(',')
    const out = result.current.parseList(names, [])
    expect(out.names.length).toBe(25)
    expect(out.clamped).toBe(true)
  })

  it('skips names exceeding 100 chars', () => {
    const { result } = renderHook(() => useInvestorChips())
    const huge = 'a'.repeat(150)
    const out = result.current.parseList(`Sequoia, ${huge}, Accel`, [])
    expect(out.names).toEqual(['Sequoia', 'Accel'])
  })
})
