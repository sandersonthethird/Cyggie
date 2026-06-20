import { useState, useEffect, useMemo, useCallback, useRef, type ReactNode } from 'react'

// FindMatch is owned by the (React-free) FindHighlight extension and re-exported
// here so existing importers keep pulling it from this hook unchanged.
export type { FindMatch } from '../lib/find-highlight-extension'
import type { FindMatch } from '../lib/find-highlight-extension'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Injects <mark> HTML tags into a markdown string at match positions.
 * Use alongside rehype-raw so the injected tags survive markdown rendering
 * while all rich-text formatting (headings, bold, lists, tables) is preserved.
 * Insertions are made right-to-left to preserve earlier offsets.
 */
export function injectFindMarks(
  text: string,
  matches: FindMatch[],
  activeIndex: number
): string {
  if (matches.length === 0) return text
  let result = text
  for (let i = matches.length - 1; i >= 0; i--) {
    const { start, end } = matches[i]
    const cls = i === activeIndex ? ' class="markActive"' : ''
    result =
      result.slice(0, start) +
      `<mark${cls}>${result.slice(start, end)}</mark>` +
      result.slice(end)
  }
  return result
}

interface UseFindInPageOptions {
  text: string
  isOpen: boolean
  onOpen: () => void
  onClose: () => void
  /**
   * When false, skip registering the global Cmd+F / Ctrl+F listener.
   * Default true.
   *
   * Used by surfaces that mount unconditionally but should only respond to
   * Cmd+F when active — notably the singleton chat-panel <PanelThread> which
   * is portaled into rail/fullscreen but mounted at app start. Pass
   * `enabled: panelIsOpen` to gate the keyboard shortcut on visibility.
   */
  enabled?: boolean
  /**
   * Element to scope the active-match scroll query to. When set, the scroll
   * effect queries `mark.markActive` WITHIN this element and centers it
   * (`block: 'center'`); when omitted it falls back to a document-wide query
   * with `block: 'nearest'`.
   *
   * Surfaces portaled to the end of <body> (e.g. the memo edit modal) pass
   * their editor's `view.dom` so a background surface's stale `mark.markActive`
   * (left open underneath) isn't what gets scrolled.
   */
  scrollRoot?: HTMLElement | null
}

interface UseFindInPageReturn {
  query: string
  setQuery: (q: string) => void
  matchCount: number
  activeMatchIndex: number
  /** Raw match positions in `text` — use with injectFindMarks for rich-text surfaces. */
  matches: FindMatch[]
  goToNext: () => void
  goToPrev: () => void
  /** Plain-text React nodes with <mark> elements — use only for plain-text previews. */
  highlightedContent: ReactNode
}

export function useFindInPage({
  text,
  isOpen,
  onOpen,
  onClose,
  enabled = true,
  scrollRoot,
}: UseFindInPageOptions): UseFindInPageReturn {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  // Hold scrollRoot in a ref so the scroll effect (deps: match index/open/count)
  // reads the latest value without adding it as a dep.
  const scrollRootRef = useRef(scrollRoot)
  scrollRootRef.current = scrollRoot
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)

  // Debounce the query for match computation
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150)
    return () => clearTimeout(timer)
  }, [query])

  // Compute matches
  const matches = useMemo<FindMatch[]>(() => {
    if (!debouncedQuery || !text) return []
    const escaped = escapeRegex(debouncedQuery)
    const regex = new RegExp(escaped, 'gi')
    const result: FindMatch[] = []
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      result.push({ start: match.index, end: match.index + match[0].length })
    }
    return result
  }, [text, debouncedQuery])

  const matchCount = matches.length

  // Reset active index when matches change
  useEffect(() => {
    setActiveMatchIndex(0)
  }, [matches])

  // Clear query when find bar closes
  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setDebouncedQuery('')
    }
  }, [isOpen])

  const goToNext = useCallback(() => {
    if (matchCount === 0) return
    setActiveMatchIndex((prev) => (prev + 1) % matchCount)
  }, [matchCount])

  const goToPrev = useCallback(() => {
    if (matchCount === 0) return
    setActiveMatchIndex((prev) => (prev - 1 + matchCount) % matchCount)
  }, [matchCount])

  // Scroll active match into view
  useEffect(() => {
    if (!isOpen || matchCount === 0) return
    // Small delay to let React render the updated marks
    const timer = setTimeout(() => {
      const root = scrollRootRef.current ?? document
      const el = root.querySelector('mark.markActive')
      // Scoped surfaces center the match; the document-wide default keeps the
      // minimal 'nearest' scroll the other surfaces have always used.
      el?.scrollIntoView({
        behavior: 'smooth',
        block: scrollRootRef.current ? 'center' : 'nearest',
      })
    }, 10)
    return () => clearTimeout(timer)
  }, [activeMatchIndex, isOpen, matchCount])

  // Cmd+F / Ctrl+F keyboard shortcut. Skipped when `enabled` is false so a
  // singleton-mounted surface (e.g., chat panel) doesn't intercept Cmd+F when
  // it isn't currently visible.
  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        onOpen()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onOpen, enabled])

  // Build highlighted content (plain-text nodes — for plain-text surfaces only)
  const highlightedContent = useMemo<ReactNode>(() => {
    if (!text) return null
    if (matches.length === 0) return text

    const parts: ReactNode[] = []
    let lastEnd = 0

    for (let i = 0; i < matches.length; i++) {
      const { start, end } = matches[i]
      if (start > lastEnd) {
        parts.push(text.slice(lastEnd, start))
      }
      parts.push(
        <mark key={i} className={i === activeMatchIndex ? 'markActive' : undefined}>
          {text.slice(start, end)}
        </mark>
      )
      lastEnd = end
    }

    if (lastEnd < text.length) {
      parts.push(text.slice(lastEnd))
    }

    return parts
  }, [text, matches, activeMatchIndex])

  return {
    query,
    setQuery,
    matchCount,
    activeMatchIndex,
    matches,
    goToNext,
    goToPrev,
    highlightedContent
  }
}
