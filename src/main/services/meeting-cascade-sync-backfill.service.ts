// =============================================================================
// meeting-cascade-sync-backfill.service.ts — one-shot enqueue of companies +
// contacts (and their child rows) that were auto-created from meetings but
// never reached the sync outbox.
//
// Companies/contacts created as a side-effect of meeting ingestion used to be
// written straight to local SQLite without emitting an outbox row (the
// `createCompanyForMeeting` / `syncContactsFromAttendees` cascades). They lived
// only on desktop and never reached Neon → invisible on mobile. The forward fix
// (those cascades now self-emit) is paired with this backfill for the rows that
// were already stuck before the fix shipped.
//
// Selector: lamport = '0' (the migration-096 default = "never emitted"). Rows
// that synced through the wrapped path already carry a non-zero lamport and are
// skipped, so this enqueues ONLY never-synced rows — no risk of clobbering
// remote/mobile edits. Idempotent: re-runs drain only the remaining '0' rows;
// steady state does zero work.
//
//   org_companies → org_company_aliases → meeting_company_links → contacts →
//   contact_emails   (FK-safe order; gateway UPSERTs each, LWW resolves any
//   row it has already seen via another path)
//
// Modeled on memo-sync-backfill.service.ts.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import {
  OWNED_TABLES_BY_NAME,
  type OwnedTableSpec,
} from '@cyggie/db/sync/owned-tables'
import { encodeRowId } from '@cyggie/db/sync/encode-row-id'
import { nextLamport } from '@cyggie/db/sync/sync-clock'

const DEVICE_ID_KEY = 'syncDeviceId'

// FK-safe order: parents before children so a child never lands at the gateway
// before its parent row.
const CASCADE_TABLES = [
  'org_companies',
  'org_company_aliases',
  'meeting_company_links',
  'contacts',
  'contact_emails',
] as const

export interface MeetingCascadeBackfillResult {
  enqueued: Record<string, number>
  skipped: number
}

/**
 * Enqueue any company/contact cascade row still at lamport='0' to the outbox.
 *
 * Early-returns when `userId` is null — the outbox.user_id column is NOT NULL
 * and we have no value to stamp without a hydrated user. Next launch retries.
 */
export function backfillMeetingCascadeForSync(
  userId: string | null,
): MeetingCascadeBackfillResult {
  const result: MeetingCascadeBackfillResult = { enqueued: {}, skipped: 0 }
  if (!userId) {
    console.log('[meeting-cascade-backfill] skipped: no user_id at launch')
    return result
  }
  const db = getDatabase()
  const deviceIdRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DEVICE_ID_KEY) as { value: string } | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    console.log('[meeting-cascade-backfill] skipped: device_id not yet provisioned')
    return result
  }

  for (const tableName of CASCADE_TABLES) {
    const spec = OWNED_TABLES_BY_NAME.get(tableName)
    if (!spec) {
      console.error(`[meeting-cascade-backfill] OWNED_TABLES missing '${tableName}'`)
      continue
    }
    let enqueued = 0
    const rows = db
      .prepare(`SELECT * FROM ${tableName} WHERE lamport = '0'`)
      .all() as Array<Record<string, unknown>>
    for (const row of rows) {
      try {
        enqueueOne(db, deviceId, userId, spec, row, tableName)
        enqueued++
      } catch (err) {
        const pk = spec.primaryKey.map((c) => String(row[c])).join('/')
        console.error(`[meeting-cascade-backfill] failed ${tableName} ${pk}:`, err)
        result.skipped++
      }
    }
    result.enqueued[tableName] = enqueued
  }

  const summary = CASCADE_TABLES.map((t) => `${t}=${result.enqueued[t] ?? 0}`).join(' ')
  console.log(`[meeting-cascade-backfill] ${summary} skipped=${result.skipped}`)
  return result
}

/**
 * One row, one transaction: mint a lamport, bump the row's lamport column,
 * insert the outbox entry. Op is 'insert' — from Neon's perspective the row
 * doesn't exist yet; the gateway UPSERTs and LWW resolves any prior copy.
 * Handles composite-PK tables (contact_emails, meeting_company_links) via
 * spec.primaryKey.
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
    const pkClause = spec.primaryKey.map((c) => `${c} = ?`).join(' AND ')
    const pkValues = spec.primaryKey.map((c) => row[c])
    db.prepare(`UPDATE ${tableName} SET lamport = ? WHERE ${pkClause}`).run(
      lamport,
      ...pkValues,
    )

    const stampedRow = { ...row, lamport }
    const rowId = encodeRowId(spec, stampedRow)
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, deviceId, tableName, rowId, 'insert', JSON.stringify(stampedRow), lamport)
  })
  tx()
}

/**
 * Fire-and-forget launcher. Defers 4s so it lands just after the memo/email/
 * custom-field backfills (3s) and doesn't compete with the SyncAgent's first
 * tick. Mirrors backfillMemosForSyncOnLaunch.
 */
export function backfillMeetingCascadeForSyncOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillMeetingCascadeForSync(userId)
    } catch (err) {
      console.error('[meeting-cascade-backfill] unexpected failure:', err)
    }
  }, 4000)
}
