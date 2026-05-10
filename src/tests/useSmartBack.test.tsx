// @vitest-environment jsdom
/**
 * Tests for useSmartBack — back/forward navigation in Electron's hash router.
 *
 * Decision tree under test:
 *
 *   goBack()
 *     │
 *   history.state.idx > 0? ──yes──▶ navigate(-1)
 *     │ no
 *   state.from set?
 *     │ yes
 *   state.from starts with '/'? ──yes──▶ navigate(state.from, { replace: true })
 *     │ no
 *   warn + fall through ──▶ navigate(fallbackRoute, { replace: true })
 *     │ (state.from missing entirely)
 *     ▼
 *   navigate(fallbackRoute, { replace: true })
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { useSmartBack } from '../renderer/hooks/useSmartBack'
import type { ReactNode } from 'react'

// Mock useNavigate at module level so we can observe calls without
// having to wrangle MemoryRouter history APIs.
const navigateMock = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigateMock }
})

function makeWrapper(
  initialEntries: Array<{ pathname: string; state?: unknown }>
): (props: { children: ReactNode }) => JSX.Element {
  return function Wrapper({ children }) {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="*" element={children} />
        </Routes>
      </MemoryRouter>
    )
  }
}

function setHistoryIdx(idx: number) {
  // useSmartBack reads window.history.state.idx — fake it.
  window.history.replaceState({ ...(window.history.state ?? {}), idx }, '')
}

describe('useSmartBack', () => {
  beforeEach(() => {
    navigateMock.mockReset()
    setHistoryIdx(0)
  })

  afterEach(() => {
    setHistoryIdx(0)
  })

  it('uses navigate(-1) when history idx > 0 (regression)', () => {
    setHistoryIdx(2)
    const { result } = renderHook(() => useSmartBack('/companies'), {
      wrapper: makeWrapper([{ pathname: '/company/123' }]),
    })
    act(() => result.current.goBack())
    expect(navigateMock).toHaveBeenCalledWith(-1)
  })

  it('navigates to state.from when idx=0 and from is a valid path', () => {
    setHistoryIdx(0)
    const { result } = renderHook(() => useSmartBack('/companies'), {
      wrapper: makeWrapper([
        { pathname: '/company/123', state: { from: '/companies?priority=high' } },
      ]),
    })
    act(() => result.current.goBack())
    expect(navigateMock).toHaveBeenCalledWith('/companies?priority=high', { replace: true })
  })

  it('falls back to fallbackRoute and warns when state.from does not start with /', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setHistoryIdx(0)
    const { result } = renderHook(() => useSmartBack('/companies'), {
      wrapper: makeWrapper([
        { pathname: '/company/123', state: { from: 'https://attacker.example' } },
      ]),
    })
    act(() => result.current.goBack())
    expect(navigateMock).toHaveBeenCalledWith('/companies', { replace: true })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('falls back to fallbackRoute when no state.from is present', () => {
    setHistoryIdx(0)
    const { result } = renderHook(() => useSmartBack('/companies'), {
      wrapper: makeWrapper([{ pathname: '/company/123' }]),
    })
    act(() => result.current.goBack())
    expect(navigateMock).toHaveBeenCalledWith('/companies', { replace: true })
  })

  it('honours state.backLabel over the default label (regression)', () => {
    const { result } = renderHook(() => useSmartBack('/companies', 'Default'), {
      wrapper: makeWrapper([
        { pathname: '/company/123', state: { backLabel: 'Companies' } },
      ]),
    })
    expect(result.current.label).toBe('Companies')
  })

  it('uses default label when state.backLabel is absent', () => {
    const { result } = renderHook(() => useSmartBack('/companies', 'Default'), {
      wrapper: makeWrapper([{ pathname: '/company/123' }]),
    })
    expect(result.current.label).toBe('Default')
  })
})
