/**
 * Citation hover overlay (Delight #4).
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  Producer agent emits `[source: <url>]` inline; the citation       │
 *   │  preprocessor rewrites those to `[¹](<url>)` Unicode-superscript   │
 *   │  links BEFORE TipTap renders the memo body. This layer attaches    │
 *   │  ONE delegated mouseenter/mouseleave listener on the memo body     │
 *   │  ref and shows a popover when the user hovers a citation link.     │
 *   │                                                                     │
 *   │  Discrimination: the layer canonicalizes the anchor's href and     │
 *   │  checks `bySource.has(canonical)`. Only producer-emitted citations │
 *   │  with matching evidence rows trigger popovers — plain markdown     │
 *   │  links in section bodies silently receive no popover                │
 *   │  (eng-review 1.1).                                                  │
 *   │                                                                     │
 *   │  Hover delays: 200ms in / 150ms out — gentler than the default     │
 *   │  Tooltip pacing for richer popovers; gives the user time to move   │
 *   │  the cursor INTO the popover to click before it dismisses.         │
 *   └────────────────────────────────────────────────────────────────────┘
 */

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { StoredMemoEvidence } from '../../../shared/types/memo-evidence'
import { canonicalizeForCitation } from '../../lib/memo-citation-preprocessor'
import styles from './CitationHoverLayer.module.css'

const VIEWPORT_PAD = 8
const HOVER_IN_DELAY_MS = 200
const HOVER_OUT_DELAY_MS = 150

interface CitationHoverLayerProps {
  /** Ref to the memo body container that TipTap renders into. */
  containerRef: RefObject<HTMLElement | null>
  /** URL → evidence rows lookup from preprocessMemoCitations. */
  bySource: Map<string, readonly StoredMemoEvidence[]>
}

interface PopoverState {
  rows: readonly StoredMemoEvidence[]
  url: string
  top: number
  left: number
}

export function CitationHoverLayer({ containerRef, bySource }: CitationHoverLayerProps) {
  const [popover, setPopover] = useState<PopoverState | null>(null)
  // Track which anchor we're currently hovering so re-fires don't cancel a
  // mid-show popover, and so leaving for the popover doesn't dismiss.
  const anchorRef = useRef<HTMLAnchorElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function clearShowTimer() {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current)
        showTimerRef.current = null
      }
    }
    function clearHideTimer() {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }

    function findCitationAnchor(target: EventTarget | null): HTMLAnchorElement | null {
      if (!(target instanceof Element)) return null
      const a = target.closest('a[href]') as HTMLAnchorElement | null
      if (!a) return null
      const canonical = canonicalizeForCitation(a.href)
      if (!canonical) return null
      if (!bySource.has(canonical)) return null
      return a
    }

    function onMouseEnter(event: Event) {
      const a = findCitationAnchor(event.target)
      if (!a) return
      clearHideTimer()
      // Same anchor already-shown: do nothing.
      if (anchorRef.current === a && popover) return
      anchorRef.current = a
      clearShowTimer()
      showTimerRef.current = setTimeout(() => {
        const canonical = canonicalizeForCitation(a.href)
        if (!canonical) return
        const rows = bySource.get(canonical)
        if (!rows || rows.length === 0) return
        const rect = a.getBoundingClientRect()
        // Position below + centered horizontally, clamped to viewport.
        let top = rect.bottom + 6
        let left = rect.left + rect.width / 2
        const vw = window.innerWidth
        const vh = window.innerHeight
        left = Math.max(VIEWPORT_PAD, Math.min(left, vw - VIEWPORT_PAD))
        top = Math.max(VIEWPORT_PAD, Math.min(top, vh - VIEWPORT_PAD))
        setPopover({ rows, url: a.href, top, left })
      }, HOVER_IN_DELAY_MS)
    }

    function onMouseLeave(event: Event) {
      const a = findCitationAnchor(event.target)
      if (!a) return
      clearShowTimer()
      // Delay-hide so the cursor can travel into the popover.
      clearHideTimer()
      hideTimerRef.current = setTimeout(() => {
        anchorRef.current = null
        setPopover(null)
      }, HOVER_OUT_DELAY_MS)
    }

    // Use mouseover/mouseout (bubble) instead of mouseenter/mouseleave
    // (no bubble) so delegation works.
    container.addEventListener('mouseover', onMouseEnter)
    container.addEventListener('mouseout', onMouseLeave)
    return () => {
      container.removeEventListener('mouseover', onMouseEnter)
      container.removeEventListener('mouseout', onMouseLeave)
      clearShowTimer()
      clearHideTimer()
    }
  }, [containerRef, bySource, popover])

  // Keep popover open while the cursor is hovered over it.
  function onPopoverEnter() {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }
  function onPopoverLeave() {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => {
      anchorRef.current = null
      setPopover(null)
    }, HOVER_OUT_DELAY_MS)
  }

  if (!popover) return null

  return createPortal(
    <div
      ref={popoverRef}
      className={styles.popover}
      style={{ top: popover.top, left: popover.left }}
      onMouseEnter={onPopoverEnter}
      onMouseLeave={onPopoverLeave}
      role="tooltip"
    >
      <CitationPopoverBody rows={popover.rows} url={popover.url} />
    </div>,
    document.body,
  )
}

/**
 * Popover body — inlined here per eng-review minimal-diff (no separate
 * CitationPopoverContent.tsx file). Layout adapts to the number of rows:
 *
 *   • 1 row  → claim + snippet + URL + Open link
 *   • N rows → "{N} claims cite this source" + scrollable list
 */
function CitationPopoverBody({
  rows,
  url,
}: {
  rows: readonly StoredMemoEvidence[]
  url: string
}) {
  if (rows.length === 1) {
    const row = rows[0]
    return (
      <div className={styles.body}>
        <div className={styles.claim}>{row.claimText}</div>
        <div className={styles.snippet}>{row.snippet}</div>
        <div className={styles.footer}>
          <a className={styles.urlLink} href={url} target="_blank" rel="noopener noreferrer">
            {hostnameOf(url)} ↗
          </a>
        </div>
      </div>
    )
  }
  return (
    <div className={styles.body}>
      <div className={styles.multiHeader}>{rows.length} claims cite this source</div>
      <ul className={styles.rows}>
        {rows.map((row) => (
          <li key={row.id} className={styles.row}>
            <div className={styles.claim}>{row.claimText}</div>
            <div className={styles.snippet}>{row.snippet}</div>
          </li>
        ))}
      </ul>
      <div className={styles.footer}>
        <a className={styles.urlLink} href={url} target="_blank" rel="noopener noreferrer">
          {hostnameOf(url)} ↗
        </a>
      </div>
    </div>
  )
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
