// @vitest-environment jsdom
/**
 * Tests for useLastView hook — persist and restore last-active table view.
 *
 * Decision tree under test:
 *
 *   MOUNT
 *     │
 *   params empty? ──no──▶ skip restore
 *     │yes
 *   localStorage has key? ──no──▶ skip restore
 *     │yes
 *   urlParams non-empty? ──no──▶ skip restore ("All" was last)
 *     │yes
 *   navigate(replace) + restore columns
 *
 *   SAVE (on param/column change)
 *     │
 *   params non-empty? ──no──▶ skip (race guard)
 *     │yes
 *   localStorage.setItem(...)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLastView } from '../renderer/hooks/useLastView'

const KEY = 'cyggie:test-last-view'
const PATH = '/test'

function makeParams(str = ''): URLSearchParams {
  return new URLSearchParams(str)
}

describe('useLastView', () => {
  let navigate: ReturnType<typeof vi.fn>
  let setVisibleKeys: ReturnType<typeof vi.fn>
  let saveColumnConfig: ReturnType<typeof vi.fn>

  beforeEach(() => {
    navigate = vi.fn()
    setVisibleKeys = vi.fn()
    saveColumnConfig = vi.fn()
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  // ── Restore tests ──────────────────────────────────────────────────────────

  describe('restore on mount', () => {
    it('restores saved view when params are empty and localStorage has non-empty urlParams', () => {
      localStorage.setItem(KEY, JSON.stringify({
        urlParams: 'fund=fund_iv&type=portfolio',
        columns: ['name', 'fund', 'stage'],
      }))

      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).toHaveBeenCalledWith(
        '/test?fund=fund_iv&type=portfolio',
        { replace: true }
      )
      expect(setVisibleKeys).toHaveBeenCalledWith(['name', 'fund', 'stage'])
      expect(saveColumnConfig).toHaveBeenCalledWith(['name', 'fund', 'stage'])
    })

    it('skips restore when searchParams are non-empty', () => {
      localStorage.setItem(KEY, JSON.stringify({
        urlParams: 'fund=fund_iv',
        columns: ['name'],
      }))

      renderHook(() =>
        useLastView(KEY, PATH, makeParams('type=portfolio'), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).not.toHaveBeenCalled()
      expect(setVisibleKeys).not.toHaveBeenCalled()
    })

    it('skips restore when localStorage is empty', () => {
      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).not.toHaveBeenCalled()
    })

    it('skips restore when saved urlParams is empty ("All" was last view)', () => {
      localStorage.setItem(KEY, JSON.stringify({
        urlParams: '',
        columns: ['name', 'email'],
      }))

      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).not.toHaveBeenCalled()
    })

    it('skips restore when localStorage contains corrupt data', () => {
      localStorage.setItem(KEY, 'not-valid-json!!!')

      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).not.toHaveBeenCalled()
    })

    it('does not restore columns when saved columns array is empty', () => {
      localStorage.setItem(KEY, JSON.stringify({
        urlParams: 'type=portfolio',
        columns: [],
      }))

      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).toHaveBeenCalled()
      expect(setVisibleKeys).not.toHaveBeenCalled()
      expect(saveColumnConfig).not.toHaveBeenCalled()
    })
  })

  // ── Save tests ─────────────────────────────────────────────────────────────

  describe('save on change', () => {
    it('saves to localStorage when params are non-empty', () => {
      renderHook(() =>
        useLastView(KEY, PATH, makeParams('type=portfolio&sort=name:asc'), ['name', 'type'], navigate, setVisibleKeys, saveColumnConfig)
      )

      const raw = localStorage.getItem(KEY)
      expect(raw).not.toBeNull()
      const saved = JSON.parse(raw!)
      expect(saved.urlParams).toBe('sort=name:asc&type=portfolio') // normalized/sorted
      expect(saved.columns).toEqual(['name', 'type'])
    })

    it('does not save when params are empty (race guard)', () => {
      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), ['name'], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(localStorage.getItem(KEY)).toBeNull()
    })
  })
})
