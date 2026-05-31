import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TranscriptSegment } from '../../../shared/types/recording'
import {
  buildBubbleSearchIndex,
  buildTranscriptItems,
  formatBubbleTimestamp,
  type TranscriptItem,
} from '../../transcript/to-me-them-view'
import type { FindMatch } from '../../hooks/useFindInPage'
import styles from './TranscriptBubbles.module.css'

export interface TranscriptBubblesProps {
  segments: TranscriptSegment[]
  speakerMap: Record<number, string>
  meSpeakerIndex: number | null
  calendarSelfName: string | null
  /** Optional class for the scroll container. */
  className?: string
  /**
   * Find-in-page matches, indexed against the joined-segment search text
   * produced by `buildBubbleSearchIndex`. MeetingDetail computes these so
   * the FindBar counter and per-bubble highlights stay in sync.
   */
  findMatches?: FindMatch[]
  /** Index into `findMatches` of the currently active match. */
  activeMatchIndex?: number
}

interface SegmentMatch {
  /** Position in the global `findMatches` array — drives active styling. */
  globalIndex: number
  /** Local start within the segment's text. */
  start: number
  /** Local end within the segment's text. */
  end: number
}

/**
 * iMessage-style transcript renderer: collapses raw diarized segments
 * into a virtualized list of left-aligned "them" bubbles and right-
 * aligned "me" bubbles, with centered timestamps at silence gaps and
 * fixed 2-min intervals.
 *
 * Virtualization uses `@tanstack/react-virtual` so a 1hr meeting with
 * 500+ utterances renders quickly and "Swap Me/Them" re-render stays
 * under a frame budget on long transcripts.
 *
 * Pure presentation — does NOT write to the meeting row itself. The
 * Swap Me/Them button (in the MeetingDetail header) is responsible for
 * persisting the flip.
 */
export function TranscriptBubbles(props: TranscriptBubblesProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  const items: TranscriptItem[] = useMemo(
    () =>
      buildTranscriptItems({
        segments: props.segments,
        speakerMap: props.speakerMap,
        meSpeakerIndex: props.meSpeakerIndex,
        calendarSelfName: props.calendarSelfName,
      }).items,
    [props.segments, props.speakerMap, props.meSpeakerIndex, props.calendarSelfName],
  )

  // Map each segment object to the matches that fall inside it. Matches that
  // straddle a segment boundary (rare — only possible if the query contains
  // the '\n' separator) are dropped: the bubble view can't render them as a
  // single span and silently dropping is less misleading than a half-mark.
  const segmentMatches: Map<TranscriptSegment, SegmentMatch[]> = useMemo(() => {
    const map = new Map<TranscriptSegment, SegmentMatch[]>()
    if (!props.findMatches || props.findMatches.length === 0) return map
    const { offsetOf } = buildBubbleSearchIndex(props.segments)
    for (let i = 0; i < props.findMatches.length; i++) {
      const m = props.findMatches[i]
      for (const seg of props.segments) {
        const off = offsetOf.get(seg)
        if (off === undefined) continue
        if (m.start >= off && m.end <= off + seg.text.length) {
          const list = map.get(seg) ?? []
          list.push({ globalIndex: i, start: m.start - off, end: m.end - off })
          map.set(seg, list)
          break
        }
      }
    }
    return map
  }, [props.segments, props.findMatches])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const item = items[index]
      if (item.kind === 'timestamp') return 28
      // Heuristic for unmeasured bubbles. The virtualizer's
      // measureElement on render replaces this with the real height,
      // so accuracy of the initial guess only affects the first paint.
      const chars = item.segments.reduce((sum, s) => sum + s.text.length, 0)
      const linesEstimate = Math.max(1, Math.ceil(chars / 64))
      return 24 + linesEstimate * 22
    },
    overscan: 8,
    getItemKey: (index) => items[index].key,
  })

  // Scroll the virtualized list so the bubble containing the active match
  // is rendered. The find hook's mark.markActive querySelector cannot scroll
  // to a DOM node that virtualization hasn't mounted yet.
  useEffect(() => {
    if (!props.findMatches || props.findMatches.length === 0) return
    const activeIdx = props.activeMatchIndex ?? 0
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind !== 'bubble') continue
      const hit = item.segments.some((seg) =>
        segmentMatches.get(seg)?.some((m) => m.globalIndex === activeIdx),
      )
      if (hit) {
        virtualizer.scrollToIndex(i, { align: 'center' })
        return
      }
    }
  }, [props.activeMatchIndex, props.findMatches, items, segmentMatches, virtualizer])

  if (items.length === 0) {
    return <div className={`${styles.container} ${props.className ?? ''}`}>
      <div className={styles.empty}>No transcript yet.</div>
    </div>
  }

  const activeIdx = props.activeMatchIndex ?? 0

  return (
    <div ref={containerRef} className={`${styles.container} ${props.className ?? ''}`}>
      <div
        className={styles.virtualList}
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index]
          return (
            <div
              key={virtualRow.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              className={styles.virtualItem}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              {item.kind === 'timestamp' ? (
                <div className={styles.timestampRow}>
                  <span className={styles.timestamp}>
                    {formatBubbleTimestamp(item.time)}
                  </span>
                </div>
              ) : (
                <div className={`${styles.bubbleRow} ${styles[item.side]}`}>
                  <div className={`${styles.bubble} ${styles[item.side]}`}>
                    {item.segments.map((seg, i) => {
                      const matches = segmentMatches.get(seg)
                      return (
                        <div key={i} className={styles.bubbleParagraph}>
                          {matches && matches.length > 0
                            ? renderWithMarks(seg.text, matches, activeIdx)
                            : seg.text}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function renderWithMarks(
  text: string,
  matches: SegmentMatch[],
  activeIndex: number,
): ReactNode[] {
  const sorted = [...matches].sort((a, b) => a.start - b.start)
  const parts: ReactNode[] = []
  let lastEnd = 0
  for (const m of sorted) {
    if (m.start > lastEnd) parts.push(text.slice(lastEnd, m.start))
    parts.push(
      <mark
        key={`m-${m.globalIndex}`}
        className={m.globalIndex === activeIndex ? 'markActive' : undefined}
      >
        {text.slice(m.start, m.end)}
      </mark>,
    )
    lastEnd = m.end
  }
  if (lastEnd < text.length) parts.push(text.slice(lastEnd))
  return parts
}
