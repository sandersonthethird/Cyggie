import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAgentRunsMigration } from '../main/database/migrations/086-agent-runs'
import { runStressTestReportsMigration } from '../main/database/migrations/092-stress-test-reports'

vi.mock('../main/database/connection', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '../main/database/connection'
import {
  persistStressTestReport,
  listReportsForMemo,
} from '../main/database/repositories/stress-test-report.repo'
import type { SubmitReviewInput } from '../shared/types/stress-test-report'

/**
 * IPC handler integration test for the stress-test success branch.
 *
 * Verifies the wiring between the agent's submit_review payload and the
 * persisted stress_test_reports row. Pure unit-level integration: no Electron
 * IPC plumbing, no React; just the data flow that happens inside the IPC
 * handler's success branch.
 */

const mockGetDb = vi.mocked(getDatabase)

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('u-1');
    CREATE TABLE investment_memos (id TEXT PRIMARY KEY);
    INSERT INTO investment_memos (id) VALUES ('memo-1');
    CREATE TABLE investment_memo_versions (
      id TEXT PRIMARY KEY, memo_id TEXT NOT NULL, version_number INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown)
      VALUES ('v-1', 'memo-1', 1, '# Memo');
  `)
  runAgentRunsMigration(db)
  runStressTestReportsMigration(db)
  db.exec(`
    INSERT INTO agent_runs (id, kind, company_id, user_id, mode, status)
      VALUES ('run-1', 'thesis_stress_test', 'co-1', 'u-1', 'stress_test', 'running');
  `)
  return db
}

describe('IPC handler — stress-test success branch (integration)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    mockGetDb.mockReturnValue(db)
  })

  it('persists a stress_test_reports row + listing returns it', () => {
    // Simulate what the IPC handler does after the agent returns success.
    const submitInput: SubmitReviewInput = {
      summary: 'Of 8 claims, 2 are weakly sourced and 1 contradicts the founder pitch.',
      recommendation: 'proceed_with_caveats',
      concerns: [
        { n: 1, claim: 'TAM is $50B', evidence: 'Gartner says $12B', whatWouldChangeMind: '2024+ primary source', severity: 'high' },
        { n: 2, claim: 'Founder exit', evidence: 'No record', whatWouldChangeMind: 'Crunchbase confirmation', severity: 'medium' },
        { n: 3, claim: 'CAC payback < 6mo', evidence: 'Unit econ slide missing details', whatWouldChangeMind: 'Cohort retention curve', severity: 'low' },
      ],
      evidence: [
        {
          claimText: 'TAM check',
          sourceType: 'web',
          sourceUrl: 'https://gartner.com/x',
          snippet: 'Gartner projects $12B',
          confidence: 'high',
          isCritique: true,
          severity: 'high',
        },
      ],
    }

    const { reportId } = persistStressTestReport({
      memoId: 'memo-1',
      runId: 'run-1',
      priorMemoVersionId: 'v-1',
      summary: submitInput.summary,
      concerns: submitInput.concerns,
      evidence: submitInput.evidence,
      recommendation: submitInput.recommendation,
      costEstimateUsd: 0.35,
      durationMs: 230_000,
      toolCallCount: 22,
      createdBy: 'u-1',
    })

    expect(reportId).toBeTruthy()

    // Now exercise listReportsForMemo as the renderer would.
    const list = listReportsForMemo('memo-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(reportId)
    expect(list[0].recommendation).toBe('proceed_with_caveats')
    expect(list[0].concernCount).toBe(3)
    expect(list[0].summary).toContain('8 claims')
  })

  it('memo is NOT mutated (no new investment_memo_versions row created)', () => {
    const before = db.prepare('SELECT COUNT(*) as c FROM investment_memo_versions').get() as { c: number }
    persistStressTestReport({
      memoId: 'memo-1',
      runId: 'run-1',
      priorMemoVersionId: 'v-1',
      summary: 'Brief but adequate summary content for tests.',
      concerns: [
        { n: 1, claim: 'Test claim one of three', evidence: 'Some evidence here', whatWouldChangeMind: 'Stronger primary source', severity: 'medium' },
        { n: 2, claim: 'Test claim two of three', evidence: 'Some evidence here', whatWouldChangeMind: 'Stronger primary source', severity: 'medium' },
        { n: 3, claim: 'Test claim three of three', evidence: 'Some evidence here', whatWouldChangeMind: 'Stronger primary source', severity: 'medium' },
      ],
      evidence: [],
      recommendation: 'proceed',
      costEstimateUsd: 0.1,
      durationMs: 10_000,
      toolCallCount: 5,
      createdBy: 'u-1',
    })
    const after = db.prepare('SELECT COUNT(*) as c FROM investment_memo_versions').get() as { c: number }
    // Critical invariant: stress-test under the new model does NOT touch memo versions.
    expect(after.c).toBe(before.c)
  })
})
