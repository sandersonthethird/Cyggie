/**
 * Section-by-section progress display during a memo producer agent run.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Replaces the legacy text-streaming <pre> when the producer    │
 *   │  agent is the active backend (vs single-call). Iterates the    │
 *   │  MEMO_SECTIONS roster, marks each entry as pending → running   │
 *   │  → completed as section_started / section_completed AgentEvents│
 *   │  arrive on the run.                                             │
 *   │                                                                 │
 *   │  Visual states per section:                                     │
 *   │   pending    — muted text, no icon                              │
 *   │   running    — bold + spinner                                   │
 *   │   completed  — checkmark + sub-line with byte length            │
 *   └────────────────────────────────────────────────────────────────┘
 */

import { useMemo } from 'react'
import { MEMO_SECTION_HEADINGS } from '../../../shared/constants/memo-sections'
import type { AgentEvent } from '../../../shared/types/agent-events'
import styles from './MemoSectionProgress.module.css'

interface MemoSectionProgressProps {
  /** AgentEvents from RunsContext for the active producer run. */
  events: readonly AgentEvent[]
  /** Status of the run; controls whether we show a "queued" message at top. */
  status: 'running' | 'success' | 'failed' | 'aborted' | 'cap_exceeded' | 'stuck'
}

type SectionState =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'completed'; bodyLength: number }

export function MemoSectionProgress({ events, status }: MemoSectionProgressProps) {
  const stateByHeading = useMemo(() => {
    const map = new Map<string, SectionState>()
    for (const h of MEMO_SECTION_HEADINGS) map.set(h, { kind: 'pending' })
    for (const ev of events) {
      if (ev.type === 'section_started') {
        map.set(ev.heading, { kind: 'running' })
      } else if (ev.type === 'section_completed') {
        map.set(ev.heading, { kind: 'completed', bodyLength: ev.bodyLength })
      }
    }
    return map
  }, [events])

  // Surface tool calls happening in the agent loop — gives the user a sense
  // of activity between section completions.
  const lastToolCall = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.type === 'tool_call') return ev.name
    }
    return null
  }, [events])

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        {status === 'running' && 'Producer agent is writing the memo…'}
        {status === 'success' && 'Producer agent completed.'}
        {status === 'failed' && 'Producer agent failed.'}
        {status === 'aborted' && 'Producer agent was cancelled.'}
        {status === 'cap_exceeded' && 'Producer agent hit a limit.'}
        {status === 'stuck' && 'Producer agent appears stuck (no events for 5 min).'}
      </div>
      {lastToolCall && status === 'running' && (
        <div className={styles.activity}>Tool call: {lastToolCall}</div>
      )}
      <ol className={styles.sections}>
        {MEMO_SECTION_HEADINGS.map((heading) => {
          const state = stateByHeading.get(heading) ?? { kind: 'pending' as const }
          return (
            <li key={heading} className={styles[`section_${state.kind}`]} data-state={state.kind}>
              <span className={styles.marker}>
                {state.kind === 'completed' ? '✓' : state.kind === 'running' ? '◐' : '○'}
              </span>
              <span className={styles.label}>{heading}</span>
              {state.kind === 'completed' && (
                <span className={styles.byteLen}>{state.bodyLength} chars</span>
              )}
              {state.kind === 'running' && <span className={styles.spinner}>·····</span>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
