/**
 * Wire/storage shape for a memo_evidence row, shared between main and renderer.
 *
 * The main-side repo ([memo-evidence.repo.ts]) maps DB rows into this shape;
 * the renderer consumes via the MEMO_EVIDENCE_LIST_BY_VERSION IPC channel.
 * Three callers in renderer (EvidenceSidebar, CompanyMemo, MemoSectionsNav)
 * and one in the citation preprocessor all use this exact shape — keeping
 * the definition shared prevents drift.
 */
export interface StoredMemoEvidence {
  id: string
  versionId: string
  claimText: string
  claimCategory: string | null
  sourceType: string
  sourceId: string | null
  sourceUrl: string | null
  snippet: string
  confidence: 'high' | 'medium' | 'low'
  severity: 'high' | 'medium' | 'low' | null
  isCritique: boolean
  /**
   * The memo section this row was attributed to (e.g. "Market / Industry").
   * NULL for legacy rows (pre-migration 090) and for stress-test agent rows
   * (which don't yet include section in their submit_memo schema).
   */
  section: string | null
  createdAt: string
}
