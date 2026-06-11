// =============================================================================
// custom-field-sync-backfill.service.ts — one-shot enqueue of pre-existing
// custom field definitions + values to the sync outbox.
//
// Custom fields joined the sync engine via migrations 119/120 (lamport added to
// custom_field_definitions + custom_field_values), OWNED_TABLES gained both
// entries, and the barrel now wraps create/update/deleteFieldDefinition +
// setFieldValue/deleteFieldValue. FUTURE writes emit via withSync. But rows
// created BEFORE this change (every existing custom field schema + value) have
// no outbox entry and never reach Neon → mobile/web can't see custom fields.
//
// This walks every def + value still at lamport='0' (the migration default /
// "not yet synced" sentinel) and enqueues one outbox row each. Definitions are
// processed BEFORE values (FK parent → child), matching OWNED_TABLES order.
//
// Mirrors memo-sync-backfill.service.ts exactly. Idempotent: re-runs pick up
// only rows still at lamport='0'.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import {
  OWNED_TABLES_BY_NAME,
  type OwnedTableSpec,
} from '@cyggie/db/sync/owned-tables'
import { encodeRowId } from '@cyggie/db/sync/encode-row-id'
import { nextLamport } from '@cyggie/db/sync/sync-clock'

const DEVICE_ID_KEY = 'syncDeviceId'

export interface CustomFieldBackfillResult {
  definitionsEnqueued: number
  valuesEnqueued: number
  skipped: number
}

/**
 * Enqueue any custom field definition / value row still at lamport='0' to the
 * outbox. Early-returns when `userId` is null (outbox.user_id is NOT NULL) —
 * next launch picks the work back up.
 */
export function backfillCustomFieldsForSync(
  userId: string | null,
): CustomFieldBackfillResult {
  const empty: CustomFieldBackfillResult = { definitionsEnqueued: 0, valuesEnqueued: 0, skipped: 0 }
  if (!userId) {
    console.log('[custom-field-sync-backfill] skipped: no user_id at launch')
    return empty
  }
  const db = getDatabase()
  const deviceIdRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DEVICE_ID_KEY) as { value: string } | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    console.log('[custom-field-sync-backfill] skipped: device_id not yet provisioned')
    return empty
  }

  const defSpec = OWNED_TABLES_BY_NAME.get('custom_field_definitions')
  const valSpec = OWNED_TABLES_BY_NAME.get('custom_field_values')
  if (!defSpec || !valSpec) {
    console.error('[custom-field-sync-backfill] OWNED_TABLES missing custom field entries')
    return empty
  }

  let definitionsEnqueued = 0
  let valuesEnqueued = 0
  let skipped = 0

  // ── definitions (FK parent) ───────────────────────────────────────────────
  const definitions = db
    .prepare("SELECT * FROM custom_field_definitions WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of definitions) {
    try {
      enqueueOne(db, deviceId, userId, defSpec, row, 'custom_field_definitions')
      definitionsEnqueued++
    } catch (err) {
      console.error(`[custom-field-sync-backfill] failed definition ${String(row['id'])}:`, err)
      skipped++
    }
  }

  // ── values (FK child) ─────────────────────────────────────────────────────
  const values = db
    .prepare("SELECT * FROM custom_field_values WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of values) {
    try {
      enqueueOne(db, deviceId, userId, valSpec, row, 'custom_field_values')
      valuesEnqueued++
    } catch (err) {
      console.error(`[custom-field-sync-backfill] failed value ${String(row['id'])}:`, err)
      skipped++
    }
  }

  console.log(
    `[custom-field-sync-backfill] definitions=${definitionsEnqueued} values=${valuesEnqueued} skipped=${skipped}`,
  )
  return { definitionsEnqueued, valuesEnqueued, skipped }
}

/**
 * One row, one transaction: mint a lamport, bump the row's lamport column,
 * insert the outbox entry. Op is 'insert' (the row doesn't exist on Neon yet).
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
    db.prepare(`UPDATE ${tableName} SET lamport = ? WHERE ${pkClause}`).run(lamport, ...pkValues)

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
 * Fire-and-forget launcher. Defers 3.5s — AFTER the consolidation backfill
 * (3s) so orphan defs are gone before survivors are enqueued, and so it
 * doesn't compete with the SyncAgent's first tick.
 */
export function backfillCustomFieldsForSyncOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillCustomFieldsForSync(userId)
    } catch (err) {
      console.error('[custom-field-sync-backfill] unexpected failure:', err)
    }
  }, 3500)
}
