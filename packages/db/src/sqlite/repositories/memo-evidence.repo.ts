import { randomUUID } from 'node:crypto'
import { getDatabase } from '../connection'
import type { EvidenceRow } from '../../../shared/types/thesis'
import type { StoredMemoEvidence } from '../../../shared/types/memo-evidence'

// Re-export so existing callers `import { StoredMemoEvidence } from '...memo-evidence.repo'` continue to work.
export type { StoredMemoEvidence }

/**
 * Repository for `memo_evidence` rows (sidecar to `investment_memo_versions`).
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  bulkInsert(versionId, rows): inserts all evidence rows for a   │
 *   │  newly-saved memo version inside a single SQLite transaction    │
 *   │  with the memo version save (caller wraps in db.transaction()).  │
 *   │                                                                 │
 *   │  Partial unique indexes (migration 085) dedupe within a version: │
 *   │    - internal rows: (version_id, claim_text, source_type,        │
 *   │                       source_id) WHERE source_type != 'web'      │
 *   │    - web rows:      (version_id, claim_text, source_url)         │
 *   │                       WHERE source_type = 'web'                  │
 *   │                                                                 │
 *   │  Use INSERT OR IGNORE so duplicate rows are silently dropped     │
 *   │  rather than aborting the bulk insert. Caller logs how many      │
 *   │  rows were inserted vs. requested for observability.             │
 *   └────────────────────────────────────────────────────────────────┘
 */

interface MemoEvidenceRow {
  id: string
  version_id: string
  claim_text: string
  claim_category: string | null
  source_type: string
  source_id: string | null
  source_url: string | null
  snippet: string
  confidence: string
  severity: string | null
  is_critique: number
  section: string | null
  created_at: string
}

function rowToStored(row: MemoEvidenceRow): StoredMemoEvidence {
  return {
    id: row.id,
    versionId: row.version_id,
    claimText: row.claim_text,
    claimCategory: row.claim_category,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    snippet: row.snippet,
    confidence: row.confidence as StoredMemoEvidence['confidence'],
    severity: (row.severity as StoredMemoEvidence['severity']) ?? null,
    isCritique: row.is_critique === 1,
    section: row.section ?? null,
    createdAt: row.created_at,
  }
}

/**
 * Insert evidence rows for a single memo version. Caller is responsible for
 * the surrounding transaction (typically the memo+evidence save in
 * investment-memo.ipc.ts is one atomic operation). Returns the number of
 * rows actually inserted (duplicates per partial unique index are skipped).
 */
export function bulkInsert(versionId: string, rows: EvidenceRow[]): number {
  const db = getDatabase()
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO memo_evidence (
      id, version_id, claim_text, claim_category, source_type,
      source_id, source_url, snippet, confidence, severity, is_critique, section
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  let inserted = 0
  for (const row of rows) {
    const result = stmt.run(
      randomUUID(),
      versionId,
      row.claimText,
      row.claimCategory ?? null,
      row.sourceType,
      row.sourceId ?? null,
      row.sourceUrl ?? null,
      row.snippet,
      row.confidence,
      row.severity ?? null,
      row.isCritique ? 1 : 0,
      row.section ?? null,
    )
    if (result.changes > 0) inserted += 1
  }
  return inserted
}

export function listByVersion(versionId: string): StoredMemoEvidence[] {
  const db = getDatabase()
  const rows = db
    .prepare(`SELECT * FROM memo_evidence WHERE version_id = ? ORDER BY datetime(created_at)`)
    .all(versionId) as MemoEvidenceRow[]
  return rows.map(rowToStored)
}

export function listByClaim(versionId: string, claimText: string): StoredMemoEvidence[] {
  const db = getDatabase()
  const rows = db
    .prepare(`SELECT * FROM memo_evidence WHERE version_id = ? AND claim_text = ?`)
    .all(versionId, claimText) as MemoEvidenceRow[]
  return rows.map(rowToStored)
}

export function listCritiquesByVersion(versionId: string): StoredMemoEvidence[] {
  const db = getDatabase()
  const rows = db
    .prepare(`SELECT * FROM memo_evidence WHERE version_id = ? AND is_critique = 1 ORDER BY datetime(created_at)`)
    .all(versionId) as MemoEvidenceRow[]
  return rows.map(rowToStored)
}
