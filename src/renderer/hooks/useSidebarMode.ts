import { useCallback, useEffect, useState } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'

type SidebarMode = 'expanded' | 'collapsed'

const PREF_KEY = 'cyggie:sidebar-mode'
const BREAKPOINT = 768

/**
 * Manages sidebar collapse/expand state with persistence and keyboard shortcut.
 *
 * State machine:
 *   ┌─ EXPANDED (240px, text + icons) ─┐
 *   │                                   │
 *   │  toggle() / Cmd+\                 │
 *   │                                   │
 *   └─ COLLAPSED (56px, icons only) ────┘
 *
 * Below 768px viewport: force collapsed, toggle is a no-op.
 * Persists to user_preferences via Zustand store.
 */
export function useSidebarMode(): {
  mode: SidebarMode
  toggle: () => void
} {
  const { getJSON, setJSON } = usePreferencesStore()
  const [forcedCollapsed, setForcedCollapsed] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < BREAKPOINT
  )

  const storedMode = getJSON<SidebarMode>(PREF_KEY, 'expanded')
  const mode: SidebarMode = forcedCollapsed ? 'collapsed' : storedMode

  const toggle = useCallback(() => {
    if (forcedCollapsed) return // no-op below breakpoint
    const next: SidebarMode = storedMode === 'expanded' ? 'collapsed' : 'expanded'
    setJSON(PREF_KEY, next)
  }, [forcedCollapsed, storedMode, setJSON])

  // Viewport resize listener — force collapsed below breakpoint
  useEffect(() => {
    const onResize = () => {
      setForcedCollapsed(window.innerWidth < BREAKPOINT)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Keyboard shortcut: Cmd+\ (Mac) / Ctrl+\ (Win)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  return { mode, toggle }
}
