import { useEffect, useRef, useState } from 'react'
import type { AgentEvent } from '../../../shared/types/agent-events'
import { useRuns, type RunRecord } from '../../contexts/RunsContext'
import styles from './ResearchLog.module.css'

/**
 * Streaming research log for an in-flight (or just-completed) agent run.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Renders the AgentEvent stream as a vertically-stacked list:    │
 *   │   - tool_call          → "Reading meeting: Pitch (Apr 12)"      │
 *   │   - tool_result_summary → "→ 2,400 words" (one-line, indented)  │
 *   │   - thinking           → italic block (collapsed by default)    │
 *   │   - cap_exceeded       → highlighted warning row                │
 *   │   - error              → highlighted error row                  │
 *   │  Auto-scrolls to bottom while running. Collapses to last 5      │
 *   │  entries 30s after completion.                                  │
 *   └────────────────────────────────────────────────────────────────┘
 */

const MAX_THINKING_PREVIEW_CHARS = 200
const COLLAPSE_AFTER_DONE_MS = 30_000
const COLLAPSED_TAIL_LENGTH = 5

export function ResearchLog({ run }: { run: RunRecord | null }) {
  const [showAll, setShowAll] = useState(false)
  const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set())
  const [collapsed, setCollapsed] = useState(false)
  // Per-row dismissals for cap_exceeded rows. Indices match `run.events`.
  // Local-only state: dismisses are a visual filter; the persisted run trace
  // still has the event. Reset when the run id changes.
  const [dismissedEventIndices, setDismissedEventIndices] = useState<Set<number>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const { dismissRun } = useRuns()

  // Auto-scroll to bottom while running.
  useEffect(() => {
    if (run?.status !== 'running') return
    const el = containerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [run?.events.length, run?.status])

  // After 30s post-done, collapse to the last 5 entries by default.
  useEffect(() => {
    if (!run || run.status === 'running') return
    const t = setTimeout(() => setShowAll(false), COLLAPSE_AFTER_DONE_MS)
    return () => clearTimeout(t)
  }, [run?.status, run?.runId])

  // Reset per-row dismissals + box-collapse state when the run identity
  // changes (new run starts in the same memo).
  useEffect(() => {
    setDismissedEventIndices(new Set())
    setCollapsed(false)
  }, [run?.runId])

  if (!run) return null

  const isRunning = run.status === 'running'
  // Visible event tuples carry their original index so per-row dismiss can
  // address an event by stable identity (slice() rebases indices otherwise).
  const eventsWithIndex = run.events.map((event, i) => ({ event, i }))
  const filteredEvents = eventsWithIndex.filter(e => !dismissedEventIndices.has(e.i))
  const visibleEvents = showAll || isRunning
    ? filteredEvents
    : filteredEvents.slice(-COLLAPSED_TAIL_LENGTH)

  const total = filteredEvents.length
  const hidden = total - visibleEvents.length

  // Header chevron — collapse the whole event list. Header stays visible.
  // Header dismiss (×) — only visible in terminal states; calls
  // RunsContext.dismissRun(runId) to remove the run from the in-memory map
  // (does NOT delete persisted agent_runs / agent_run_events rows).
  const isTerminal = !isRunning && run.status !== 'stuck'

  // .status-running already has a pulse animation in CSS; we enhanced it to
  // also scale so the alive signal is visible in peripheral vision during the
  // 5-30s quiet stretches between agent events.
  const statusDotClass = `${styles.statusDot} ${styles[`status-${run.status}`]}`

  return (
    <section className={styles.log} aria-live="polite">
      <header className={styles.header}>
        <button
          className={styles.chevronBtn}
          onClick={() => setCollapsed(c => !c)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand research log' : 'Collapse research log'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className={statusDotClass} />
        <span className={styles.statusLabel}>{statusLabel(run.status)}</span>
        <span className={styles.runId}>run {run.runId.slice(0, 8)}</span>
        {!collapsed && hidden > 0 ? (
          <button className={styles.toggle} onClick={() => setShowAll(true)}>
            Show full trace ({hidden} earlier)
          </button>
        ) : !collapsed && run.status !== 'running' && total > COLLAPSED_TAIL_LENGTH ? (
          <button className={styles.toggle} onClick={() => setShowAll(false)}>
            Collapse list
          </button>
        ) : null}
        {isTerminal && (
          <button
            className={styles.dismissBtn}
            onClick={() => dismissRun(run.runId)}
            aria-label="Dismiss research log"
            title="Dismiss"
          >
            ×
          </button>
        )}
      </header>
      {!collapsed && (
        <>
          <div className={styles.events} ref={containerRef}>
            {visibleEvents.length === 0 ? (
              <p className={styles.empty}>Waiting for the agent to start…</p>
            ) : (
              visibleEvents.map(({ event, i }) => (
                <EventRow
                  key={i}
                  event={event}
                  expanded={expandedThinking.has(i)}
                  onToggleThinking={() => toggleSetItem(setExpandedThinking, i)}
                  onDismiss={event.type === 'cap_exceeded'
                    ? () => setDismissedEventIndices(prev => {
                        const next = new Set(prev)
                        next.add(i)
                        return next
                      })
                    : undefined}
                />
              ))
            )}
            {/* Animated "alive" indicator anchored at the bottom of the event
                list. Rides the auto-scroll so users always see it while running,
                even during 5-30s quiet stretches between events. */}
            {isRunning && (
              <div className={styles.thinkingRow}>
                <span className={styles.thinkingDots} aria-hidden="true">
                  <span /><span /><span />
                </span>
                <span className={styles.thinkingLabel}>thinking…</span>
              </div>
            )}
          </div>
          {run.errorMessage ? (
            <p className={styles.errorMessage}>{run.errorMessage}</p>
          ) : null}
        </>
      )}
    </section>
  )
}

function EventRow({
  event,
  expanded,
  onToggleThinking,
  onDismiss,
}: {
  event: AgentEvent
  expanded: boolean
  onToggleThinking: () => void
  /** When set, the row renders a × button that calls this on click. Only
   * provided by the parent for cap_exceeded rows under the new dismiss UX. */
  onDismiss?: () => void
}) {
  switch (event.type) {
    case 'started':
      return <Row icon="▶" label={`Started (${event.kind})`} dim />
    case 'iteration_start':
      return <Row icon="•" label={`Turn ${event.n}`} dim />
    case 'thinking':
      return (
        <div className={styles.thinking}>
          <button className={styles.thinkingToggle} onClick={onToggleThinking} aria-expanded={expanded}>
            {expanded ? '▾' : '▸'} thinking
          </button>
          <p className={styles.thinkingText}>
            {expanded ? event.text : truncate(event.text, MAX_THINKING_PREVIEW_CHARS)}
          </p>
        </div>
      )
    case 'tool_call':
      return <Row icon="→" label={`${event.name}(${formatInputPreview(event.input)})`} mono />
    case 'tool_result_summary':
      return <Row icon="  ←" label={event.summary} dim />
    case 'tool_error':
      return <Row icon="✕" label={`tool error: ${truncate(event.message, 100)}`} error />
    case 'final_text_chunk':
      return null   // streamed memo body — surfaced elsewhere
    case 'cap_exceeded':
      return (
        <Row
          icon="⚠"
          label={`Cap reached: ${event.cap} (${event.used}/${event.limit}) — raise in Settings → Agents`}
          warn
          onDismiss={onDismiss}
        />
      )
    case 'done':
      return <Row icon="✓" label={`Done — $${event.costEstimateUsd.toFixed(2)}, ${(event.durationMs / 1000).toFixed(0)}s, ${event.toolCallCount} tool calls`} success />
    case 'error':
      return <Row icon="✕" label={`Error: ${event.errorClass} — ${truncate(event.message, 120)}`} error />
    case 'aborted':
      return <Row icon="◻" label="Aborted" dim />
    default:
      return null
  }
}

function Row({
  icon,
  label,
  mono,
  dim,
  warn,
  error,
  success,
  onDismiss,
}: {
  icon: string
  label: string
  mono?: boolean
  dim?: boolean
  warn?: boolean
  error?: boolean
  success?: boolean
  onDismiss?: () => void
}) {
  const cls = [
    styles.row,
    mono ? styles.mono : '',
    dim ? styles.dim : '',
    warn ? styles.warn : '',
    error ? styles.error : '',
    success ? styles.success : '',
  ].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      <span className={styles.icon}>{icon}</span>
      <span className={styles.label}>{label}</span>
      {onDismiss && (
        <button
          className={styles.rowDismissBtn}
          onClick={onDismiss}
          aria-label="Dismiss this notice"
          title="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  )
}

function statusLabel(status: RunRecord['status']): string {
  switch (status) {
    case 'running': return 'Researching…'
    case 'success': return 'Complete'
    case 'failed':  return 'Failed'
    case 'aborted': return 'Cancelled'
    case 'cap_exceeded': return 'Cap reached'
    case 'stuck':   return 'Stalled (no events for 5min)'
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function formatInputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  const entries = Object.entries(obj).slice(0, 2)
  return entries.map(([k, v]) => `${k}: ${truncate(String(v), 30)}`).join(', ')
}

function toggleSetItem<T>(setter: (fn: (prev: Set<T>) => Set<T>) => void, item: T): void {
  setter(prev => {
    const next = new Set(prev)
    if (next.has(item)) next.delete(item)
    else next.add(item)
    return next
  })
}
