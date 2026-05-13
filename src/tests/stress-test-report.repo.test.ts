import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAgentRunsMigration } from '../main/database/migrations/086-agent-runs'
import { runStressTestReportsMigration } from '../main/database/migrations/092-stress-test-reports'
import { runStressTestReportsNoFkMigration } from '../main/database/migrations/093-stress-test-reports-no-fk'

vi.mock('../main/database/connection', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '../main/database/connection'
import {
  persistStressTestReport,
  listReportsForMemo,
  getStressTestReport,
} from '../main/database/repositories/stress-test-report.repo'

const mockGetDb = vi.mocked(getDatabase)

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Prerequisite tables for FK targets
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (id) VALUES ('u-1');

    CREATE TABLE investment_memos (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO investment_memos (id) VALUES ('memo-1');

    CREATE TABLE investment_memo_versions (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown)
      VALUES ('v-1', 'memo-1', 1, '# Memo');
  `)
  runAgentRunsMigration(db)
  runStressTestReportsMigration(db)
  // Migration 093 drops the FK-enforced table and recreates it without FK
  // constraints. Tests exercise the post-093 schema (matches production).
  runStressTestReportsNoFkMigration(db)
  // Seed an agent_runs row for the happy-path test (still a real row, just
  // not FK-enforced anymore).
  db.exec(`
    INSERT INTO agent_runs (id, kind, company_id, user_id, mode, status)
      VALUES ('run-1', 'thesis_stress_test', 'co-1', 'u-1', 'stress_test', 'running');
  `)
  return db
}

const baseInput = {
  memoId: 'memo-1',
  runId: 'run-1',
  priorMemoVersionId: 'v-1',
  summary: 'Of 11 claims reviewed, 3 weakly sourced. Recommend caveats.',
  concerns: [
    { n: 1, claim: 'TAM is $50B by 2027', evidence: 'Gartner says $12B', whatWouldChangeMind: 'A 2024+ source projecting $40B+', severity: 'high' as const },
    { n: 2, claim: 'Founder has prior exit', evidence: 'No record of exit in LinkedIn or Crunchbase', whatWouldChangeMind: 'A primary source for the exit', severity: 'medium' as const },
    { n: 3, claim: 'Team is 12 engineers', evidence: 'LinkedIn shows 7', whatWouldChangeMind: 'A direct headcount from the founder', severity: 'low' as const },
  ],
  evidence: [],
  recommendation: 'proceed_with_caveats' as const,
  costEstimateUsd: 0.35,
  durationMs: 230_000,
  toolCallCount: 22,
  createdBy: 'u-1',
}

describe('stress-test-report.repo', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    mockGetDb.mockReturnValue(db)
  })

  it('persistStressTestReport writes a row with all fields preserved', () => {
    const { reportId } = persistStressTestReport(baseInput)
    expect(reportId).toMatch(/^[0-9a-f-]+$/i)

    const got = getStressTestReport(reportId)
    expect(got).not.toBeNull()
    expect(got!.memoId).toBe('memo-1')
    expect(got!.priorMemoVersionId).toBe('v-1')
    expect(got!.summary).toContain('11 claims')
    expect(got!.recommendation).toBe('proceed_with_caveats')
    expect(got!.concerns).toHaveLength(3)
    expect(got!.concerns[0].claim).toContain('TAM')
    expect(got!.costEstimateUsd).toBeCloseTo(0.35, 2)
    expect(got!.toolCallCount).toBe(22)
  })

  it('listReportsForMemo orders DESC by created_at', () => {
    // Seed two runs so we can persist two reports.
    db.exec(`
      INSERT INTO agent_runs (id, kind, company_id, user_id, mode, status)
        VALUES ('run-2', 'thesis_stress_test', 'co-1', 'u-1', 'stress_test', 'success');
    `)
    persistStressTestReport(baseInput)
    // Force a measurable time gap so created_at differs (sqlite datetime is second-resolution).
    db.exec(`UPDATE stress_test_reports SET created_at = '2026-01-01 10:00:00'`)
    persistStressTestReport({ ...baseInput, runId: 'run-2' })
    db.exec(`UPDATE stress_test_reports SET created_at = '2026-01-02 10:00:00' WHERE run_id = 'run-2'`)

    const rows = listReportsForMemo('memo-1')
    expect(rows).toHaveLength(2)
    expect(rows[0].runId).toBe('run-2')   // newer first
    expect(rows[1].runId).toBe('run-1')
    expect(rows[0].concernCount).toBe(3)
    expect(rows[0].recommendation).toBe('proceed_with_caveats')
  })

  it('listReportsForMemo returns empty array for memo with no reports', () => {
    expect(listReportsForMemo('memo-with-nothing')).toEqual([])
  })

  it('getStressTestReport returns null for unknown id', () => {
    expect(getStressTestReport('does-not-exist')).toBeNull()
  })

  it('listReportsForMemo concernCount handles malformed JSON gracefully', () => {
    persistStressTestReport(baseInput)
    db.exec(`UPDATE stress_test_reports SET concerns_json = 'not-json'`)
    const rows = listReportsForMemo('memo-1')
    expect(rows[0].concernCount).toBe(0)
  })

  it('persist succeeds even when FK target rows do NOT exist (migration 093 dropped FK enforcement)', () => {
    // Locks the new semantics: stress_test_reports is observability data;
    // orphan rows are acceptable. Pre-093, this would throw
    // "FOREIGN KEY constraint failed" because none of these ids exist.
    const orphanInput = {
      ...baseInput,
      memoId: 'memo-does-not-exist',
      runId: 'run-does-not-exist',
      priorMemoVersionId: 'v-does-not-exist',
      createdBy: 'user-does-not-exist',
    }
    expect(() => persistStressTestReport(orphanInput)).not.toThrow()
    const list = listReportsForMemo('memo-does-not-exist')
    expect(list).toHaveLength(1)
    expect(list[0].recommendation).toBe('proceed_with_caveats')
  })
})
