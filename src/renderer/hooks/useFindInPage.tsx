import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface FindMatch {
  start: number
  end: number
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
  onClose
}: UseFindInPageOptions): UseFindInPageReturn {
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
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
      const el = document.querySelector('mark.markActive')
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 10)
    return () => clearTimeout(timer)
  }, [activeMatchIndex, isOpen, matchCount])

  // Cmd+F / Ctrl+F keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        onOpen()
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onOpen])

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
