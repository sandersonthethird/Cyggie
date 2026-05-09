import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { AgentEvent } from '../../shared/types/agent-events'
import styles from './DevAgentRuns.module.css'

/**
 * /dev/agent-runs — built-in observability dashboard for agent runs.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Top: cost summary across the visible window (this week's      │
 *   │  spend, average run cost, top company, P99 latency, failed      │
 *   │  runs).                                                          │
 *   │  Below: a table of agent_runs (most recent first); click a row  │
 *   │  to expand its full event trace via agent_run_events.            │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * This is "joy to operate" infra: when something feels off, click the run,
 * see the trace.
 */

interface StoredAgentRun {
  id: string
  kind: string
  companyId: string
  userId: string
  mode: string | null
  status: string
  startedAt: string
  endedAt: string | null
  iterations: number
  inputTokensTotal: number
  outputTokensTotal: number
  costEstimateUsd: number
  toolCallCount: number
  webSearchCount: number
  errorClass: string | null
  errorMessage: string | null
  resultVersionId: string | null
}

interface StoredAgentRunEvent {
  id: number
  runId: string
  ts: string
  eventType: string
  payload: AgentEvent
}

const STATUS_LABEL: Record<string, string> = {
  running: '⏵ running',
  success: '✓ ok',
  failed: '✕ failed',
  aborted: '◻ aborted',
  cap_exceeded: '⚠ cap',
  orphaned: '☠ orphan',
}

export default function DevAgentRuns() {
  const [runs, setRuns] = useState<StoredAgentRun[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [events, setEvents] = useState<StoredAgentRunEvent[]>([])
  const [eventsLoading, setEventsLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void api
      .invoke<StoredAgentRun[]>(IPC_CHANNELS.AGENT_RUNS_LIST, { limit: 100 })
      .then(rows => { if (!cancelled) setRuns(rows ?? []) })
      .catch(() => { if (!cancelled) setRuns([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const summary = useMemo(() => buildSummary(runs), [runs])

  async function expandRun(runId: string) {
    if (expanded === runId) {
      setExpanded(null)
      setEvents([])
      return
    }
    setExpanded(runId)
    setEventsLoading(true)
    try {
      const rows = await api.invoke<StoredAgentRunEvent[]>(IPC_CHANNELS.AGENT_RUN_LIST_EVENTS, runId)
      setEvents(rows ?? [])
    } finally {
      setEventsLoading(false)
    }
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Agent Runs</h1>
        <p className={styles.subtitle}>{loading ? 'Loading…' : `Last ${runs.length} runs`}</p>
      </header>

      {!loading && runs.length > 0 && (
        <section className={styles.summary}>
          <Stat label="Total spend" value={`$${summary.totalCost.toFixed(2)}`} />
          <Stat label="Avg run cost" value={`$${summary.avgCost.toFixed(2)}`} />
          <Stat label="P99 latency" value={`${summary.p99Latency}s`} />
          <Stat label="Failed runs" value={String(summary.failedCount)} />
          <Stat label="Top company" value={summary.topCompany} />
        </section>
      )}

      {!loading && runs.length === 0 && (
        <p className={styles.empty}>No agent runs yet. Click "Stress-test" or "Generate with AI" on a company.</p>
      )}

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Time</th>
            <th>Kind</th>
            <th>Company</th>
            <th>Status</th>
            <th>Iter</th>
            <th>In/Out tokens</th>
            <th>Cost</th>
            <th>Tools</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          {runs.map(run => (
            <Row
              key={run.id}
              run={run}
              expanded={expanded === run.id}
              onToggle={() => expandRun(run.id)}
              events={expanded === run.id ? events : []}
              eventsLoading={eventsLoading && expanded === run.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  )
}

function Row({
  run,
  expanded,
  onToggle,
  events,
  eventsLoading,
}: {
  run: StoredAgentRun
  expanded: boolean
  onToggle: () => void
  events: StoredAgentRunEvent[]
  eventsLoading: boolean
}) {
  const duration = run.endedAt
    ? Math.round((new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null
  return (
    <>
      <tr className={`${styles.row} ${expanded ? styles.rowExpanded : ''}`} onClick={onToggle}>
        <td className={styles.cellMono}>{formatTime(run.startedAt)}</td>
        <td>{run.kind}</td>
        <td className={styles.cellMono}>{run.companyId.slice(0, 8)}</td>
        <td className={`${styles.status} ${styles[`status-${run.status}`]}`}>{STATUS_LABEL[run.status] ?? run.status}</td>
        <td className={styles.cellNum}>{run.iterations}</td>
        <td className={styles.cellNum}>{formatTokens(run.inputTokensTotal)}/{formatTokens(run.outputTokensTotal)}</td>
        <td className={styles.cellNum}>${run.costEstimateUsd.toFixed(2)}</td>
        <td className={styles.cellNum}>{run.toolCallCount}</td>
        <td className={styles.cellNum}>{duration != null ? `${duration}s` : '—'}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={9} className={styles.expandCell}>
            {eventsLoading ? (
              <p className={styles.empty}>Loading trace…</p>
            ) : events.length === 0 ? (
              <p className={styles.empty}>No events recorded.</p>
            ) : (
              <ol className={styles.trace}>
                {events.map(e => (
                  <li key={e.id} className={styles.traceItem}>
                    <span className={styles.traceTs}>{formatTime(e.ts).split(' ')[1]}</span>
                    <span className={styles.traceType}>{e.eventType}</span>
                    <span className={styles.tracePayload}>{summarizePayload(e.payload)}</span>
                  </li>
                ))}
              </ol>
            )}
            {run.errorMessage && (
              <p className={styles.errorMessage}>{run.errorClass}: {run.errorMessage}</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function buildSummary(runs: StoredAgentRun[]): {
  totalCost: number
  avgCost: number
  p99Latency: number
  failedCount: number
  topCompany: string
} {
  const completed = runs.filter(r => r.endedAt && r.status !== 'orphaned')
  const totalCost = completed.reduce((s, r) => s + r.costEstimateUsd, 0)
  const avgCost = completed.length ? totalCost / completed.length : 0
  const durations = completed
    .map(r => (new Date(r.endedAt!).getTime() - new Date(r.startedAt).getTime()) / 1000)
    .sort((a, b) => a - b)
  const p99Latency = durations.length
    ? Math.round(durations[Math.floor(durations.length * 0.99)] ?? 0)
    : 0
  const failedCount = completed.filter(r => r.status === 'failed' || r.status === 'cap_exceeded').length
  const byCompany = new Map<string, number>()
  for (const r of completed) byCompany.set(r.companyId, (byCompany.get(r.companyId) ?? 0) + r.costEstimateUsd)
  const top = [...byCompany.entries()].sort((a, b) => b[1] - a[1])[0]
  return {
    totalCost,
    avgCost,
    p99Latency,
    failedCount,
    topCompany: top ? `${top[0].slice(0, 8)} ($${top[1].toFixed(2)})` : '—',
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function summarizePayload(p: AgentEvent): string {
  switch (p.type) {
    case 'tool_call': return `${p.name}(${formatPreview(p.input)})`
    case 'tool_result_summary': return p.summary
    case 'thinking': return truncate(p.text, 120)
    case 'tool_error': return truncate(p.message, 120)
    case 'cap_exceeded': return `${p.cap} ${p.used}/${p.limit}`
    case 'error': return `${p.errorClass}: ${truncate(p.message, 120)}`
    case 'done': return `→ $${p.costEstimateUsd.toFixed(2)} / ${(p.durationMs / 1000).toFixed(1)}s`
    case 'iteration_start': return `turn ${p.n}`
    case 'started': return `kind=${p.kind} mode=${p.mode}`
    case 'aborted': return ''
    default: return ''
  }
}

function formatPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const entries = Object.entries(input as Record<string, unknown>).slice(0, 2)
  return entries.map(([k, v]) => `${k}: ${truncate(String(v), 30)}`).join(', ')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
