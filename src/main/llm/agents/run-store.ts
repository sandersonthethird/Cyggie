import { randomUUID } from 'node:crypto'
import { getDatabase } from '../../database/connection'
import type { AgentEvent, AgentRunMode } from '../../../shared/types/agent-events'

/**
 * Repository for `agent_runs` and `agent_run_events` (per migrations 086, 087).
 *
 * Shared by every multi-turn agent run. Today:
 *   • `kind='thesis_stress_test'`  — adversarial reviewer of an existing memo
 *   • `kind='memo_producer'`       — section-by-section memo author
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Run lifecycle:                                                  │
 *   │   start()   → INSERT row with status='running', started_at=now  │
 *   │   appendEvent / flushEvents → buffered insert into run_events    │
 *   │   complete() → UPDATE status='success'/'failed'/'aborted'/       │
 *   │                'cap_exceeded' + token totals + cost + version    │
 *   │                                                                 │
 *   │  Orphan GC (called once at app launch from connection.ts after   │
 *   │  migrations): rows with status='running' and started_at older    │
 *   │  than ORPHAN_THRESHOLD_MIN are flipped to 'orphaned'.             │
 *   │                                                                 │
 *   │  Event buffering: callers use appendEvent() during the loop;     │
 *   │  flushEvents() commits the batch to SQLite. Hot-loop sync writes │
 *   │  per event would add ~ms × N to total agent latency without      │
 *   │  meaningful upside.                                              │
 *   └────────────────────────────────────────────────────────────────┘
 */

const ORPHAN_THRESHOLD_MIN = 30

export interface AgentRunStartInput {
  kind: string
  companyId: string
  userId: string
  mode: AgentRunMode
}

export interface AgentRunCompletion {
  status: 'success' | 'failed' | 'aborted' | 'cap_exceeded' | 'orphaned'
  iterations: number
  inputTokensTotal: number
  outputTokensTotal: number
  costEstimateUsd: number
  toolCallCount: number
  webSearchCount: number
  errorClass?: string | null
  errorMessage?: string | null
  resultVersionId?: string | null
}

export interface StoredAgentRun {
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

interface AgentRunRow {
  id: string
  kind: string
  company_id: string
  user_id: string
  mode: string | null
  status: string
  started_at: string
  ended_at: string | null
  iterations: number
  input_tokens_total: number
  output_tokens_total: number
  cost_estimate_usd: number
  tool_call_count: number
  web_search_count: number
  error_class: string | null
  error_message: string | null
  result_version_id: string | null
}

function rowToStored(row: AgentRunRow): StoredAgentRun {
  return {
    id: row.id,
    kind: row.kind,
    companyId: row.company_id,
    userId: row.user_id,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    iterations: row.iterations,
    inputTokensTotal: row.input_tokens_total,
    outputTokensTotal: row.output_tokens_total,
    costEstimateUsd: row.cost_estimate_usd,
    toolCallCount: row.tool_call_count,
    webSearchCount: row.web_search_count,
    errorClass: row.error_class,
    errorMessage: row.error_message,
    resultVersionId: row.result_version_id,
  }
}

/**
 * Begin a run: insert a row with status='running'. Returns the new run id
 * (uuid v4) for the caller to thread through emit events and tool calls.
 */
export function startRun(input: AgentRunStartInput): string {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO agent_runs (id, kind, company_id, user_id, mode, status)
    VALUES (?, ?, ?, ?, ?, 'running')
  `).run(id, input.kind, input.companyId, input.userId, input.mode)
  return id
}

/**
 * Mark a run complete with terminal status + accounting. Idempotent on
 * re-call (no-op if status is already terminal).
 */
export function completeRun(runId: string, completion: AgentRunCompletion): void {
  const db = getDatabase()
  db.prepare(`
    UPDATE agent_runs
       SET status = ?,
           ended_at = datetime('now'),
           iterations = ?,
           input_tokens_total = ?,
           output_tokens_total = ?,
           cost_estimate_usd = ?,
           tool_call_count = ?,
           web_search_count = ?,
           error_class = ?,
           error_message = ?,
           result_version_id = ?
     WHERE id = ?
       AND status = 'running'
  `).run(
    completion.status,
    completion.iterations,
    completion.inputTokensTotal,
    completion.outputTokensTotal,
    completion.costEstimateUsd,
    completion.toolCallCount,
    completion.webSearchCount,
    completion.errorClass ?? null,
    completion.errorMessage ?? null,
    completion.resultVersionId ?? null,
    runId,
  )
}

/**
 * Buffered event writer. Returns a function that:
 *   - appendEvent(e):  pushes onto an in-memory buffer
 *   - flush():         executes a single transaction for all buffered events
 * Caller flushes per turn boundary and on completion. The agent loop emits
 * many events per turn (thinking, tool_call, tool_result_summary, ...);
 * batching avoids per-event sync-write contention.
 */
export function makeEventWriter(runId: string): {
  appendEvent: (event: AgentEvent) => void
  flush: () => void
} {
  const buffer: Array<{ event_type: string; payload_json: string }> = []
  return {
    appendEvent(event) {
      buffer.push({ event_type: event.type, payload_json: JSON.stringify(event) })
    },
    flush() {
      if (buffer.length === 0) return
      const db = getDatabase()
      const stmt = db.prepare(`
        INSERT INTO agent_run_events (run_id, event_type, payload_json) VALUES (?, ?, ?)
      `)
      const tx = db.transaction((events: typeof buffer) => {
        for (const e of events) stmt.run(runId, e.event_type, e.payload_json)
      })
      tx(buffer)
      buffer.length = 0
    },
  }
}

export function getRun(runId: string): StoredAgentRun | null {
  const db = getDatabase()
  const row = db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(runId) as AgentRunRow | undefined
  return row ? rowToStored(row) : null
}

export function listRuns(filter?: {
  companyId?: string
  kind?: string
  limit?: number
}): StoredAgentRun[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []
  if (filter?.companyId) { conditions.push('company_id = ?'); params.push(filter.companyId) }
  if (filter?.kind)      { conditions.push('kind = ?'); params.push(filter.kind) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filter?.limit ?? 100
  const rows = db
    .prepare(`SELECT * FROM agent_runs ${where} ORDER BY datetime(started_at) DESC LIMIT ?`)
    .all(...params, limit) as AgentRunRow[]
  return rows.map(rowToStored)
}

export interface StoredAgentRunEvent {
  id: number
  runId: string
  ts: string
  eventType: string
  payload: AgentEvent
}

export function listRunEvents(runId: string): StoredAgentRunEvent[] {
  const db = getDatabase()
  const rows = db
    .prepare(`SELECT id, run_id, ts, event_type, payload_json FROM agent_run_events WHERE run_id = ? ORDER BY id`)
    .all(runId) as Array<{ id: number; run_id: string; ts: string; event_type: string; payload_json: string }>
  return rows.map(r => ({
    id: r.id,
    runId: r.run_id,
    ts: r.ts,
    eventType: r.event_type,
    payload: JSON.parse(r.payload_json) as AgentEvent,
  }))
}

/**
 * Average cost across the most recent N completed runs of the given kind for
 * the given company. Used by the renderer's cost-badge on the Stress-test
 * button — the user sees an estimate before clicking.
 */
export function averageCostForKind(kind: string, companyId?: string, lastN = 10): number | null {
  const db = getDatabase()
  const conditions = ["kind = ?", "status IN ('success', 'failed', 'cap_exceeded')"]
  const params: unknown[] = [kind]
  if (companyId) { conditions.push('company_id = ?'); params.push(companyId) }
  const where = `WHERE ${conditions.join(' AND ')}`
  const rows = db
    .prepare(`SELECT cost_estimate_usd FROM agent_runs ${where} ORDER BY datetime(started_at) DESC LIMIT ?`)
    .all(...params, lastN) as Array<{ cost_estimate_usd: number }>
  if (rows.length === 0) return null
  const total = rows.reduce((sum, r) => sum + (r.cost_estimate_usd ?? 0), 0)
  return total / rows.length
}

/**
 * Orphan-run garbage collection. Called once at app launch (after migrations).
 * Any row stuck at status='running' with started_at older than the threshold
 * was abandoned by a previous app session — flip to 'orphaned' so it doesn't
 * appear active in the in-flight UI gates.
 *
 * Returns the number of rows GC'd; caller logs for observability.
 */
export function gcOrphanedRuns(): number {
  const db = getDatabase()
  const result = db.prepare(`
    UPDATE agent_runs
       SET status = 'orphaned',
           ended_at = datetime('now'),
           error_class = 'OrphanedAtLaunch',
           error_message = 'app exited or crashed during run'
     WHERE status = 'running'
       AND datetime(started_at) < datetime('now', ?)
  `).run(`-${ORPHAN_THRESHOLD_MIN} minutes`)
  return result.changes ?? 0
}
