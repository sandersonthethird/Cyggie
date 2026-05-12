import { randomUUID } from 'node:crypto'
import { getDatabase } from '../connection'
import type { EvidenceRow } from '../../../shared/types/thesis'
import type {
  Concern,
  Recommendation,
  StressTestReport,
  StressTestReportSummary,
} from '../../../shared/types/stress-test-report'

/**
 * Repository for `stress_test_reports`.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  persist(input): INSERT a row with parsed JSON columns           │
 *   │  list(memoId, limit): list summaries ordered DESC by created_at  │
 *   │  get(id): full report with JSON parsed                           │
 *   │                                                                 │
 *   │  Stress-test runs produce ONE report per success. The IPC        │
 *   │  handler calls persist() inside the same success branch that     │
 *   │  used to call persistMemoArtifacts. No memo version is saved.    │
 *   └────────────────────────────────────────────────────────────────┘
 */

interface PersistInput {
  memoId: string
  runId: string
  priorMemoVersionId: string
  summary: string
  concerns: Concern[]
  evidence: EvidenceRow[]
  recommendation: Recommendation
  costEstimateUsd: number
  durationMs: number
  toolCallCount: number
  createdBy: string
}

interface ReportRow {
  id: string
  memo_id: string
  run_id: string
  prior_memo_version_id: string
  summary: string
  concerns_json: string
  evidence_json: string
  recommendation: string
  cost_estimate_usd: number
  duration_ms: number
  tool_call_count: number
  created_at: string
  created_by: string
}

function rowToReport(row: ReportRow): StressTestReport {
  return {
    id: row.id,
    memoId: row.memo_id,
    runId: row.run_id,
    priorMemoVersionId: row.prior_memo_version_id,
    summary: row.summary,
    concerns: JSON.parse(row.concerns_json) as Concern[],
    evidence: JSON.parse(row.evidence_json) as EvidenceRow[],
    recommendation: row.recommendation as Recommendation,
    costEstimateUsd: row.cost_estimate_usd,
    durationMs: row.duration_ms,
    toolCallCount: row.tool_call_count,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}

export function persistStressTestReport(input: PersistInput): { reportId: string } {
  const db = getDatabase()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO stress_test_reports (
      id, memo_id, run_id, prior_memo_version_id,
      summary, concerns_json, evidence_json, recommendation,
      cost_estimate_usd, duration_ms, tool_call_count,
      created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.memoId,
    input.runId,
    input.priorMemoVersionId,
    input.summary,
    JSON.stringify(input.concerns),
    JSON.stringify(input.evidence),
    input.recommendation,
    input.costEstimateUsd,
    input.durationMs,
    input.toolCallCount,
    input.createdBy,
  )
  console.info('[stress-test-report] saved', id, 'for memo', input.memoId)
  return { reportId: id }
}

/**
 * List summaries (lightweight) for a memo, most recent first. Avoids parsing
 * the full evidence/concerns JSON until the user opens a specific report.
 */
export function listReportsForMemo(memoId: string, limit = 50): StressTestReportSummary[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT id, memo_id, run_id, summary, recommendation, concerns_json,
           cost_estimate_usd, created_at
      FROM stress_test_reports
     WHERE memo_id = ?
     ORDER BY datetime(created_at) DESC
     LIMIT ?
  `).all(memoId, limit) as Array<{
    id: string
    memo_id: string
    run_id: string
    summary: string
    recommendation: string
    concerns_json: string
    cost_estimate_usd: number
    created_at: string
  }>
  return rows.map(r => {
    // Parse concerns just enough to count; full parse happens on demand.
    let concernCount = 0
    try {
      const arr = JSON.parse(r.concerns_json) as unknown[]
      concernCount = Array.isArray(arr) ? arr.length : 0
    } catch {
      // malformed JSON — count as 0
    }
    return {
      id: r.id,
      memoId: r.memo_id,
      runId: r.run_id,
      summary: r.summary,
      recommendation: r.recommendation as Recommendation,
      concernCount,
      costEstimateUsd: r.cost_estimate_usd,
      createdAt: r.created_at,
    }
  })
}

export function getStressTestReport(id: string): StressTestReport | null {
  const db = getDatabase()
  const row = db.prepare(`SELECT * FROM stress_test_reports WHERE id = ?`).get(id) as
    | ReportRow
    | undefined
  return row ? rowToReport(row) : null
}
