import { getDatabase } from '@cyggie/db/sqlite/connection'
// Use the barrel so saveMemoVersion flows through the sync outbox. Nested
// better-sqlite3 transactions use a SAVEPOINT under the outer db.transaction
// below, so atomicity with the evidence inserts is preserved.
import * as memoRepo from '@cyggie/db/sqlite/repositories'
import { bulkInsert as bulkInsertEvidence } from '@cyggie/db/sqlite/repositories/memo-evidence.repo'
import type { EvidenceRow } from '@shared/types/thesis'

/**
 * Shared transactional persistence for memo artifacts.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  One `db.transaction()` writes, in order:                       │
 *   │    1. INSERT investment_memo_versions row                        │
 *   │    2. UPDATE investment_memos.latest_version_number              │
 *   │    3. INSERT OR IGNORE memo_evidence rows (UNIQUE indexes from   │
 *   │       migration 085 dedupe within a version)                     │
 *   │                                                                 │
 *   │  Any failure rolls back ALL of the above — no orphaned version   │
 *   │  row, no orphaned evidence rows.                                 │
 *   │                                                                 │
 *   │  Caller (producer agent or stress-test agent) separately calls   │
 *   │  completeRun(...) on the agent_runs row AFTER this succeeds, so  │
 *   │  the run record reflects the resolved version_id.                │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Used by:
 *   • thesis-stress-test (IPC handler — see investment-memo.ipc.ts persist
 *     block; refactored to call this)
 *   • memo-producer-agent
 */
export function persistMemoArtifacts(input: {
  memoId: string
  contentMarkdown: string
  changeNote: string
  userId: string | null
  evidenceRows: EvidenceRow[]
}): { versionId: string; versionNumber: number; evidenceInserted: number } {
  const db = getDatabase()
  let versionId = ''
  let versionNumber = 0
  let evidenceInserted = 0

  const txn = db.transaction(() => {
    const version = memoRepo.saveMemoVersion(
      input.memoId,
      {
        contentMarkdown: input.contentMarkdown,
        changeNote: input.changeNote,
      },
      input.userId,
    )
    versionId = version.id
    versionNumber = version.versionNumber
    if (input.evidenceRows.length > 0) {
      evidenceInserted = bulkInsertEvidence(version.id, input.evidenceRows)
    }
  })
  txn()

  return { versionId, versionNumber, evidenceInserted }
}
