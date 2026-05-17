import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { buildTestDbFull } from './_fixtures/test-db'

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '@cyggie/db/sqlite/connection'
import {
  startRun, completeRun, getRun, listRuns, listRunEvents,
  makeEventWriter, averageCostForKind, gcOrphanedRuns,
} from '../main/llm/agents/run-store'
import { bulkInsert, listByVersion, listCritiquesByVersion } from '@cyggie/db/sqlite/repositories/memo-evidence.repo'

const mockGetDb = vi.mocked(getDatabase)

function makeDb(): Database.Database {
  const db = buildTestDbFull()
  // Disable foreign keys for this test — it exercises run-store insert/update
  // logic against canonical schema, not referential integrity. Production
  // satisfies FKs via the natural insertion order; tests use ad-hoc IDs.
  db.pragma('foreign_keys = OFF')
  // Seed an investment_memo_versions row used as resultVersionId target.
  db.prepare(
    `INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown)
     VALUES ('v-1', 'memo-1', 1, '# Memo')`
  ).run()
  return db
}

describe('run-store + memo-evidence integration', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    mockGetDb.mockReturnValue(db)
  })

  describe('startRun + completeRun', () => {
    it('inserts a running row that completeRun finalizes', () => {
      const id = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      const before = getRun(id)!
      expect(before.status).toBe('running')

      completeRun(id, {
        status: 'success',
        iterations: 11,
        inputTokensTotal: 287_000,
        outputTokensTotal: 18_000,
        costEstimateUsd: 1.18,
        toolCallCount: 14,
        webSearchCount: 4,
        resultVersionId: 'v-1',
      })

      const after = getRun(id)!
      expect(after.status).toBe('success')
      expect(after.endedAt).not.toBeNull()
      expect(after.iterations).toBe(11)
      expect(after.inputTokensTotal).toBe(287_000)
      expect(after.costEstimateUsd).toBeCloseTo(1.18, 2)
      expect(after.resultVersionId).toBe('v-1')
    })

    it('completeRun is idempotent — second call no-ops', () => {
      const id = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      completeRun(id, { status: 'success', iterations: 1, inputTokensTotal: 0, outputTokensTotal: 0, costEstimateUsd: 0, toolCallCount: 0, webSearchCount: 0 })
      completeRun(id, { status: 'failed', iterations: 99, inputTokensTotal: 999, outputTokensTotal: 999, costEstimateUsd: 99, toolCallCount: 99, webSearchCount: 99 })
      const r = getRun(id)!
      expect(r.status).toBe('success')
      expect(r.iterations).toBe(1)
    })
  })

  describe('makeEventWriter', () => {
    it('flushes buffered events as a single transaction', () => {
      const id = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      const writer = makeEventWriter(id)
      writer.appendEvent({ type: 'iteration_start', runId: id, n: 1 })
      writer.appendEvent({ type: 'tool_call', runId: id, toolUseId: 'tu1', name: 'list_meetings', input: {} })
      writer.appendEvent({ type: 'tool_result_summary', runId: id, toolUseId: 'tu1', summary: 'list_meetings → 3 results', bytes: 200, truncated: false, ms: 5 })
      writer.flush()
      const events = listRunEvents(id)
      expect(events).toHaveLength(3)
      expect(events.map(e => e.eventType)).toEqual(['iteration_start', 'tool_call', 'tool_result_summary'])
    })

    it('flush() with empty buffer is a no-op', () => {
      const id = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      const writer = makeEventWriter(id)
      expect(() => writer.flush()).not.toThrow()
      expect(listRunEvents(id)).toHaveLength(0)
    })
  })

  describe('listRuns + averageCostForKind', () => {
    it('lists runs filtered by company and kind', () => {
      const a = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      const b = startRun({ kind: 'thesis_stress_test', companyId: 'co-2', userId: 'u-1', mode: 'stress_test' })
      const c = startRun({ kind: 'memo_generate', companyId: 'co-1', userId: 'u-1', mode: 'cold' })
      completeRun(a, { status: 'success', iterations: 1, inputTokensTotal: 100_000, outputTokensTotal: 1000, costEstimateUsd: 0.32, toolCallCount: 5, webSearchCount: 1 })
      completeRun(b, { status: 'success', iterations: 1, inputTokensTotal: 200_000, outputTokensTotal: 2000, costEstimateUsd: 0.63, toolCallCount: 8, webSearchCount: 2 })
      completeRun(c, { status: 'success', iterations: 1, inputTokensTotal: 50_000, outputTokensTotal: 500, costEstimateUsd: 0.16, toolCallCount: 0, webSearchCount: 0 })

      expect(listRuns({ companyId: 'co-1' })).toHaveLength(2)
      expect(listRuns({ kind: 'thesis_stress_test' })).toHaveLength(2)
      expect(listRuns({ companyId: 'co-1', kind: 'thesis_stress_test' })).toHaveLength(1)
    })

    it('averageCostForKind returns null with no runs, average otherwise', () => {
      expect(averageCostForKind('thesis_stress_test')).toBeNull()
      const a = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      completeRun(a, { status: 'success', iterations: 1, inputTokensTotal: 0, outputTokensTotal: 0, costEstimateUsd: 1.0, toolCallCount: 0, webSearchCount: 0 })
      const b = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      completeRun(b, { status: 'success', iterations: 1, inputTokensTotal: 0, outputTokensTotal: 0, costEstimateUsd: 2.0, toolCallCount: 0, webSearchCount: 0 })
      expect(averageCostForKind('thesis_stress_test')).toBeCloseTo(1.5, 2)
    })

    it('averageCostForKind ignores runs still running', () => {
      const a = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      completeRun(a, { status: 'success', iterations: 1, inputTokensTotal: 0, outputTokensTotal: 0, costEstimateUsd: 1.5, toolCallCount: 0, webSearchCount: 0 })
      startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })  // still running
      expect(averageCostForKind('thesis_stress_test')).toBeCloseTo(1.5, 2)
    })
  })

  describe('gcOrphanedRuns', () => {
    it('flips stuck running rows older than 30min to orphaned', () => {
      // Insert a running row with started_at 31 minutes ago
      db.prepare(`
        INSERT INTO agent_runs (id, kind, company_id, user_id, status, started_at)
        VALUES ('orphan-1', 'thesis_stress_test', 'co-1', 'u-1', 'running', datetime('now', '-31 minutes'))
      `).run()
      // Insert a fresh running row (5 min ago) — should NOT be GC'd
      db.prepare(`
        INSERT INTO agent_runs (id, kind, company_id, user_id, status, started_at)
        VALUES ('fresh-1', 'thesis_stress_test', 'co-1', 'u-1', 'running', datetime('now', '-5 minutes'))
      `).run()

      const gcd = gcOrphanedRuns()
      expect(gcd).toBe(1)

      const orphan = getRun('orphan-1')!
      expect(orphan.status).toBe('orphaned')
      expect(orphan.errorClass).toBe('OrphanedAtLaunch')
      expect(orphan.endedAt).not.toBeNull()

      const fresh = getRun('fresh-1')!
      expect(fresh.status).toBe('running')
    })

    it('returns 0 when nothing is stuck', () => {
      expect(gcOrphanedRuns()).toBe(0)
    })

    it('does not touch already-terminal rows', () => {
      const id = startRun({ kind: 'thesis_stress_test', companyId: 'co-1', userId: 'u-1', mode: 'stress_test' })
      completeRun(id, { status: 'failed', iterations: 1, inputTokensTotal: 0, outputTokensTotal: 0, costEstimateUsd: 0, toolCallCount: 0, webSearchCount: 0 })
      // Backdate it
      db.prepare(`UPDATE agent_runs SET started_at = datetime('now', '-2 hours') WHERE id = ?`).run(id)
      gcOrphanedRuns()
      expect(getRun(id)!.status).toBe('failed')
    })
  })

  describe('memo-evidence bulkInsert', () => {
    it('inserts a batch of evidence rows', () => {
      const inserted = bulkInsert('v-1', [
        {
          claimText: 'Acme has 220% NRR',
          claimCategory: 'traction',
          sourceType: 'meeting',
          sourceId: 'mtg-1',
          snippet: 'Confirmed in pitch',
          confidence: 'high',
          isCritique: false,
        },
        {
          claimText: 'TAM $14B',
          claimCategory: 'market',
          sourceType: 'web',
          sourceUrl: 'https://example.com/report',
          snippet: 'Per ABC research',
          confidence: 'medium',
          isCritique: false,
        },
      ])
      expect(inserted).toBe(2)
      expect(listByVersion('v-1')).toHaveLength(2)
    })

    it('skips duplicate internal rows (partial unique index)', () => {
      // Migration 090 expanded the partial UNIQUE index to include `section`.
      // SQLite treats NULL as not-equal-to-NULL in UNIQUE constraints, so two
      // rows with section=NULL are considered distinct. Set a non-null section
      // so dedup actually kicks in.
      const dup = {
        claimText: 'claim',
        sourceType: 'meeting' as const,
        sourceId: 'mtg-1',
        snippet: 's',
        confidence: 'high' as const,
        isCritique: false,
        section: 'thesis',
      }
      bulkInsert('v-1', [dup])
      const inserted2 = bulkInsert('v-1', [dup])
      expect(inserted2).toBe(0)
      expect(listByVersion('v-1')).toHaveLength(1)
    })

    it('listCritiquesByVersion filters to is_critique=1', () => {
      bulkInsert('v-1', [
        { claimText: 'a', sourceType: 'note', sourceId: 'n1', snippet: 's', confidence: 'high', isCritique: false },
        { claimText: 'risky', sourceType: 'web', sourceUrl: 'https://x.com', snippet: 's', confidence: 'medium', severity: 'high', isCritique: true },
      ])
      const critiques = listCritiquesByVersion('v-1')
      expect(critiques).toHaveLength(1)
      expect(critiques[0]!.claimText).toBe('risky')
      expect(critiques[0]!.severity).toBe('high')
    })
  })
})
