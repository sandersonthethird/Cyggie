// =============================================================================
// memo-sync-backfill.service.ts — one-shot enqueue of pre-existing memos +
// versions to the sync outbox.
//
// Memos joined the sync engine on 2026-05-23 (migration 101 added lamport
// to investment_memos + investment_memo_versions; OWNED_TABLES gained both
// entries; barrel wraps createMemo / saveMemoVersion / updateMemoStatus).
// FUTURE writes flow through withSync automatically. But historical rows
// (memos written before this change) have no outbox entry and never reach
// Neon → mobile's Memos tab on company detail can't see them.
//
// This backfill walks every existing memo + version and enqueues one
// outbox row per row, scoped to the launching user. Uses lamport='0' as
// the "not yet synced" sentinel (matches the migration default); once a
// row has been backfilled (and the SyncAgent drains it), its lamport
// reflects the current logical clock and we skip it on subsequent runs.
//
//   ┌────────────────────────────────────────────────────────────────┐
//   │ SELECT * FROM investment_memos WHERE lamport = '0'             │
//   │ for each row:                                                   │
//   │   open tx → mint lamport → UPDATE memo SET lamport=newLamport  │
//   │            → INSERT outbox(table='investment_memos', op='insert')│
//   │ commit                                                          │
//   │                                                                 │
//   │ SELECT * FROM investment_memo_versions WHERE lamport = '0'     │
//   │ same dance, table='investment_memo_versions'                    │
//   │                                                                 │
//   │ SyncAgent next tick → POST /sync/push → Neon → mobile renders  │
//   └────────────────────────────────────────────────────────────────┘
//
// Idempotent: re-runs after a partial completion (app crashed mid-loop)
// pick up only the rows still at lamport='0'. Steady state once everyone
// is backfilled: zero rows iterated, zero work done.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import {
  OWNED_TABLES_BY_NAME,
  type OwnedTableSpec,
} from '@cyggie/db/sync/owned-tables'
import { encodeRowId } from '@cyggie/db/sync/encode-row-id'
import { nextLamport } from '@cyggie/db/sync/sync-clock'

const DEVICE_ID_KEY = 'syncDeviceId'

export interface MemoBackfillResult {
  memosEnqueued: number
  versionsEnqueued: number
  skipped: number
}

/**
 * Enqueue any memo / version row still at lamport='0' to the outbox.
 * Returns counters for the launch-log line.
 *
 * Early-returns when `userId` is null — same posture as summary-backfill,
 * since the outbox.user_id column is NOT NULL and we have no value to
 * stamp without a hydrated user. Next launch picks the work back up.
 */
export function backfillMemosForSync(
  userId: string | null,
): MemoBackfillResult {
  const empty: MemoBackfillResult = { memosEnqueued: 0, versionsEnqueued: 0, skipped: 0 }
  if (!userId) {
    console.log('[memo-sync-backfill] skipped: no user_id at launch')
    return empty
  }
  const db = getDatabase()
  // Inline the device-id lookup rather than coupling to sync-bootstrap —
  // the setting key is the same across modules (see sync-bootstrap.ts and
  // cyggie-auth.ts which both read 'syncDeviceId').
  const deviceIdRow = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(DEVICE_ID_KEY) as { value: string } | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    console.log('[memo-sync-backfill] skipped: device_id not yet provisioned')
    return empty
  }

  const memoSpec = OWNED_TABLES_BY_NAME.get('investment_memos')
  const versionSpec = OWNED_TABLES_BY_NAME.get('investment_memo_versions')
  if (!memoSpec || !versionSpec) {
    // Shouldn't happen — owned-tables.ts ships both entries.
    console.error('[memo-sync-backfill] OWNED_TABLES missing memo entries')
    return empty
  }

  let memosEnqueued = 0
  let versionsEnqueued = 0
  let skipped = 0

  // ── memos ───────────────────────────────────────────────────────────────
  const memos = db
    .prepare("SELECT * FROM investment_memos WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of memos) {
    try {
      enqueueOne(db, deviceId, userId, memoSpec, row, 'investment_memos')
      memosEnqueued++
    } catch (err) {
      console.error(`[memo-sync-backfill] failed memo ${String(row['id'])}:`, err)
      skipped++
    }
  }

  // ── versions ────────────────────────────────────────────────────────────
  const versions = db
    .prepare("SELECT * FROM investment_memo_versions WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of versions) {
    try {
      enqueueOne(db, deviceId, userId, versionSpec, row, 'investment_memo_versions')
      versionsEnqueued++
    } catch (err) {
      console.error(`[memo-sync-backfill] failed version ${String(row['id'])}:`, err)
      skipped++
    }
  }

  console.log(
    `[memo-sync-backfill] memos=${memosEnqueued} versions=${versionsEnqueued} skipped=${skipped}`,
  )
  return { memosEnqueued, versionsEnqueued, skipped }
}

/**
 * One row, one transaction: mint a lamport, bump the row's lamport
 * column, insert the outbox entry. Op is 'insert' — from Neon's
 * perspective the row doesn't exist yet, so an INSERT ON CONFLICT
 * UPDATE applies cleanly even if the gateway has already seen the row
 * via some other path (LWW resolves via lamport comparison).
 */
function enqueueOne(
  db: import('better-sqlite3').Database,
  deviceId: string,
  userId: string,
  spec: OwnedTableSpec,
  row: Record<string, unknown>,
  tableName: string,
): void {
  const tx = db.transaction(() => {
    const lamport = nextLamport(db, deviceId)
    // PK update — single-col tables use 'id'; composite-PK tables (none
    // among the memo tables, but defensive) use spec.primaryKey.
    const pkClause = spec.primaryKey.map((c) => `${c} = ?`).join(' AND ')
    const pkValues = spec.primaryKey.map((c) => row[c])
    db.prepare(
      `UPDATE ${tableName} SET lamport = ? WHERE ${pkClause}`,
    ).run(lamport, ...pkValues)

    // Stamp the lamport on the row state we're about to enqueue so the
    // outbox payload matches the post-update row state in SQLite.
    const stampedRow = { ...row, lamport }
    const rowId = encodeRowId(spec, stampedRow)
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      deviceId,
      tableName,
      rowId,
      'insert',
      JSON.stringify(stampedRow),
      lamport,
    )
  })
  tx()
}

/**
 * Fire-and-forget launcher. Defers 3s so it doesn't compete with the
 * SyncAgent's first tick (which kicks off as soon as bootstrapSync runs).
 * Mirrors backfillMissingSummariesOnLaunch and gateway-credentials's
 * backfillAnthropicKeyOnLaunch patterns.
 */
export function backfillMemosForSyncOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillMemosForSync(userId)
    } catch (err) {
      console.error('[memo-sync-backfill] unexpected failure:', err)
    }
  }, 3000)
}
