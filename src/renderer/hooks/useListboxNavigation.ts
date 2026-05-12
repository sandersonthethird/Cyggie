import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

/**
 * Headless ArrowUp/Down/Enter/Escape navigation for a flat list of items
 * presented under a text input (autocomplete / typeahead / combobox).
 *
 * Design:
 *
 *   ┌─────────────────────┐
 *   │ <input onKeyDown=…> │── delegates → hook.onKeyDown(e)
 *   └─────────────────────┘                       │
 *                                                 ▼
 *   ┌─────────────────────┐    handled?     true → consumed
 *   │   ↑ / ↓ / ↵ / Esc   │── returns ─────────────────────
 *   └─────────────────────┘                false → site can run its own
 *                                                  fallback (Tab confirm,
 *                                                  fuzzy-match Enter, etc.)
 *
 *   ┌─────────────────────┐
 *   │ <ul ref={listRef}>  │── on activeIndex change, hook scrolls
 *   │   <li>…</li>        │    children[activeIndex] into view
 *   │   <li className=    │
 *   │     active>…</li>   │
 *   └─────────────────────┘
 *
 * onKeyDown returns true when it consumed a key — sites with extra keys
 * (Tab, Backspace, custom Enter logic) should call it last and short-circuit:
 *
 *   onKeyDown={(e) => {
 *     if (e.key === 'Tab') { handleTab(); return }
 *     if (hookKeyDown(e)) return
 *     // …site-specific fallthrough
 *   }}
 *
 * The hook clamps `activeIndex` whenever items shrinks below it but does NOT
 * auto-reset when items change identity — callers fetching fresh results
 * should call `setActiveIndex(initialIndex)` explicitly. This avoids fighting
 * with re-renders that pass `results ?? []` (new array each render).
 *
 * Pass `enabled: false` while the dropdown is closed to short-circuit all keys.
 */

export interface UseListboxNavigationOptions<T> {
  onSelect: (item: T, index: number) => void
  onEscape?: () => void
  enabled?: boolean
  wrap?: boolean
  initialIndex?: number
}

export interface UseListboxNavigationResult {
  activeIndex: number
  setActiveIndex: (n: number) => void
  onKeyDown: (e: KeyboardEvent) => boolean
  listRef: RefObject<HTMLElement | null>
}

export function useListboxNavigation<T>(
  items: readonly T[],
  options: UseListboxNavigationOptions<T>
): UseListboxNavigationResult {
  const { onSelect, onEscape, enabled = true, wrap = false, initialIndex = 0 } = options
  const [activeIndex, setActiveIndex] = useState(initialIndex)
  const listRef = useRef<HTMLElement | null>(null)

  // Clamp when items shrinks below activeIndex — never reach into a
  // missing slot — but leave the index alone when items grows or replaces
  // in place. Callers fetching new results should setActiveIndex themselves.
  // The explicit equality guard prevents a setState-during-render loop when
  // the clamp target equals the current value.
  if (items.length === 0) {
    if (activeIndex !== initialIndex) setActiveIndex(initialIndex)
  } else if (activeIndex >= items.length) {
    setActiveIndex(items.length - 1)
  }

  // Scroll the active child into view when the index moves out of the viewport.
  // The typeof guard keeps the hook safe under jsdom (no scrollIntoView) and any
  // future test/SSR environment that omits it.
  useEffect(() => {
    const list = listRef.current
    if (!list || activeIndex < 0) return
    const child = list.children[activeIndex] as HTMLElement | undefined
    if (child && typeof child.scrollIntoView === 'function') {
      child.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex])

  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!enabled) return false

      if (e.key === 'Escape') {
        if (onEscape) {
          e.preventDefault()
          onEscape()
          return true
        }
        return false
      }

      if (items.length === 0) return false

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => {
          if (i < 0) return 0
          if (i >= items.length - 1) return wrap ? 0 : items.length - 1
          return i + 1
        })
        return true
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => {
          if (i <= 0) return wrap ? items.length - 1 : 0
          return i - 1
        })
        return true
      }

      if (e.key === 'Enter') {
        if (activeIndex < 0 || activeIndex >= items.length) return false
        e.preventDefault()
        onSelect(items[activeIndex], activeIndex)
        return true
      }

      return false
    },
    [enabled, items, activeIndex, onSelect, onEscape, wrap]
  )

  return { activeIndex, setActiveIndex, onKeyDown, listRef }
}
