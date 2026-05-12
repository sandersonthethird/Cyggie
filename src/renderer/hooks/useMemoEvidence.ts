import { useEffect, useState } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { StoredMemoEvidence } from '../../shared/types/memo-evidence'
import { api } from '../api'

/**
 * Shared hook for fetching memo_evidence rows for a memo version.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Three callers consume the same shape:                           │
 *   │   • EvidenceSidebar — substring-match filter by activeClaim      │
 *   │   • CompanyMemo — feeds the citation preprocessor                │
 *   │   • MemoSectionsNav — groups by section for the hover popover   │
 *   │                                                                   │
 *   │  IPC errors → empty array (matches EvidenceSidebar's prior       │
 *   │  degradation pattern). Caller distinguishes "loading" from       │
 *   │  "loaded-empty" via the `loaded` flag rather than the array      │
 *   │  length so the CompanyMemo block-until-ready gate can wait on   │
 *   │  evidence before kicking the first content-load into TipTap.     │
 *   └──────────────────────────────────────────────────────────────────┘
 */

export interface UseMemoEvidenceResult {
  evidence: StoredMemoEvidence[]
  /** True once the fetch has settled (success or error). False during load. */
  loaded: boolean
}

export function useMemoEvidence(versionId: string | null | undefined): UseMemoEvidenceResult {
  const [evidence, setEvidence] = useState<StoredMemoEvidence[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!versionId) {
      setEvidence([])
      setLoaded(true)
      return
    }
    let cancelled = false
    setLoaded(false)
    void api
      .invoke<StoredMemoEvidence[]>(IPC_CHANNELS.MEMO_EVIDENCE_LIST_BY_VERSION, versionId)
      .then(rows => { if (!cancelled) setEvidence(rows ?? []) })
      .catch((err) => {
        if (cancelled) return
        console.warn('[useMemoEvidence] fetch failed:', err)
        setEvidence([])
      })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [versionId])

  return { evidence, loaded }
}
