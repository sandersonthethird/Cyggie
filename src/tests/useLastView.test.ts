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

    it('strips the transient "new" param before saving (modal toggle, not view state)', () => {
      renderHook(() =>
        useLastView(KEY, PATH, makeParams('new=1&type=portfolio'), ['name'], navigate, setVisibleKeys, saveColumnConfig)
      )

      const saved = JSON.parse(localStorage.getItem(KEY)!)
      expect(saved.urlParams).toBe('type=portfolio')
    })

    it('does not save when only transient params are present', () => {
      renderHook(() =>
        useLastView(KEY, PATH, makeParams('new=1'), ['name'], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(localStorage.getItem(KEY)).toBeNull()
    })
  })

  // ── restorePending (anti-flash gate) ────────────────────────────────────────

  describe('restorePending gate', () => {
    function renderWith(initial: URLSearchParams) {
      return renderHook(
        ({ params }: { params: URLSearchParams }) =>
          useLastView(KEY, PATH, params, [], navigate, setVisibleKeys, saveColumnConfig),
        { initialProps: { params: initial } },
      )
    }

    it('is true on a bare URL when a non-empty saved view will be restored', () => {
      localStorage.setItem(KEY, JSON.stringify({ urlParams: 'scope=founders', columns: [] }))
      const { result } = renderWith(makeParams(''))
      expect(result.current.restorePending).toBe(true)
    })

    it('flips to false once the restored params land (URL no longer bare)', () => {
      localStorage.setItem(KEY, JSON.stringify({ urlParams: 'scope=founders', columns: [] }))
      const { result, rerender } = renderWith(makeParams(''))
      expect(result.current.restorePending).toBe(true)
      // Simulate the restore navigation committing (mock navigate doesn't mutate
      // searchParams, so we feed the restored params via rerender).
      rerender({ params: makeParams('scope=founders') })
      expect(result.current.restorePending).toBe(false)
    })

    it('is false when the URL already has params at mount (no gating)', () => {
      localStorage.setItem(KEY, JSON.stringify({ urlParams: 'scope=founders', columns: [] }))
      const { result } = renderWith(makeParams('scope=investors'))
      expect(result.current.restorePending).toBe(false)
    })

    it('is false on a bare URL with no saved view', () => {
      const { result } = renderWith(makeParams(''))
      expect(result.current.restorePending).toBe(false)
    })

    it('is false when the saved view normalizes to empty (only transient params) — no navigate, must not gate forever', () => {
      localStorage.setItem(KEY, JSON.stringify({ urlParams: 'new=1', columns: [] }))
      const { result } = renderWith(makeParams(''))
      expect(result.current.restorePending).toBe(false)
    })

    it('does not re-gate after the user later clears filters back to "All" (latch)', () => {
      localStorage.setItem(KEY, JSON.stringify({ urlParams: 'scope=founders', columns: [] }))
      const { result, rerender } = renderWith(makeParams(''))
      expect(result.current.restorePending).toBe(true)
      rerender({ params: makeParams('scope=founders') }) // restore landed
      expect(result.current.restorePending).toBe(false)
      rerender({ params: makeParams('') })               // user clears to All (bare)
      expect(result.current.restorePending).toBe(false)  // stays released
    })
  })

  describe('restore strips transient params from stale saves', () => {
    it('strips "new" param from a pre-fix saved view so the add-modal does not re-open', () => {
      localStorage.setItem(KEY, JSON.stringify({
        urlParams: 'new=1&type=portfolio',
        columns: ['name'],
      }))

      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).toHaveBeenCalledWith('/test?type=portfolio', { replace: true })
    })

    it('skips restore entirely when the only saved param was "new"', () => {
      localStorage.setItem(KEY, JSON.stringify({
        urlParams: 'new=1',
        columns: ['name'],
      }))

      renderHook(() =>
        useLastView(KEY, PATH, makeParams(''), [], navigate, setVisibleKeys, saveColumnConfig)
      )

      expect(navigate).not.toHaveBeenCalled()
    })
  })
})
