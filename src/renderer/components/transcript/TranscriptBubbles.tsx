import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TranscriptSegment } from '../../../shared/types/recording'
import {
  buildTranscriptItems,
  formatBubbleTimestamp,
  type TranscriptItem,
} from '../../transcript/to-me-them-view'
import styles from './TranscriptBubbles.module.css'

export interface TranscriptBubblesProps {
  segments: TranscriptSegment[]
  speakerMap: Record<number, string>
  meSpeakerIndex: number | null
  calendarSelfName: string | null
  /** Optional class for the scroll container. */
  className?: string
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

  if (items.length === 0) {
    return <div className={`${styles.container} ${props.className ?? ''}`}>
      <div className={styles.empty}>No transcript yet.</div>
    </div>
  }

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
                    {item.segments.map((seg, i) => (
                      <div key={i} className={styles.bubbleParagraph}>
                        {seg.text}
                      </div>
                    ))}
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
