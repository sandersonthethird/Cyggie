// =============================================================================
// email-sync-backfill.service.ts — enqueue email rows to the sync outbox.
//
// Email joined the sync engine for gateway/mobile chat-context parity (Part B):
// migration 113 added lamport to email_messages / email_company_links /
// email_contact_links; OWNED_TABLES gained all three.
//
// Unlike memos (whose writes flow through withSync-wrapped repos), email rows
// are written by the ingest service via RAW SQL — they never pass through a
// wrapped repo, so no outbox entry is emitted at write time. This service is
// the bridge: it walks every email row still at lamport='0' (the migration
// default + "not yet synced" sentinel) and enqueues one outbox row each,
// scoped to the launching user. It runs:
//   • on launch (backfillEmailsForSyncOnLaunch) — historical + last-session rows
//   • after each Gmail ingest run (backfillEmailsAfterIngest) — fresh rows
//
//   ┌────────────────────────────────────────────────────────────────┐
//   │ messages first (FK parent), then company + contact links:        │
//   │ SELECT * FROM email_messages WHERE lamport = '0'                 │
//   │ for each: open tx → mint lamport → UPDATE …SET lamport           │
//   │   → INSERT outbox(op='insert', payload=PROJECTED+TRUNCATED row)  │
//   │ commit                                                           │
//   └────────────────────────────────────────────────────────────────┘
//
// body_text is TRUNCATED to BODY_TEXT_CAP in the OUTBOX PAYLOAD only — the
// SQLite row keeps its full body for desktop-local use. Raw 100 KB bodies
// never reach Neon. Idempotent: re-runs pick up only rows still at lamport='0'.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import {
  OWNED_TABLES_BY_NAME,
  type OwnedTableSpec,
} from '@cyggie/db/sync/owned-tables'
import { encodeRowId } from '@cyggie/db/sync/encode-row-id'
import { nextLamport } from '@cyggie/db/sync/sync-clock'

const DEVICE_ID_KEY = 'syncDeviceId'

/**
 * Cap body_text in the synced payload (Part D). Must be ≥ the gateway renderer's
 * per-thread cap (10 KB) so a synced message isn't pre-truncated below what the
 * chat will render. Plain top-slice (not keep-both-ends): reconstruction strips
 * quoted history per message at render time, so the raw top of each message is
 * what's needed.
 */
const BODY_TEXT_CAP = 12_000

export interface EmailBackfillResult {
  messagesEnqueued: number
  companyLinksEnqueued: number
  contactLinksEnqueued: number
  skipped: number
}

const EMPTY: EmailBackfillResult = {
  messagesEnqueued: 0,
  companyLinksEnqueued: 0,
  contactLinksEnqueued: 0,
  skipped: 0,
}

/**
 * Enqueue any email row still at lamport='0' to the outbox. Returns counters
 * for the launch / post-ingest log line. Early-returns when `userId` is null
 * (outbox.user_id is NOT NULL and we have nothing to stamp) — the next run
 * picks the work back up.
 */
export function backfillEmailsForSync(userId: string | null): EmailBackfillResult {
  if (!userId) {
    console.log('[email-sync-backfill] skipped: no user_id')
    return EMPTY
  }
  const db = getDatabase()
  const deviceIdRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DEVICE_ID_KEY) as { value: string } | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    console.log('[email-sync-backfill] skipped: device_id not yet provisioned')
    return EMPTY
  }

  const messageSpec = OWNED_TABLES_BY_NAME.get('email_messages')
  const companyLinkSpec = OWNED_TABLES_BY_NAME.get('email_company_links')
  const contactLinkSpec = OWNED_TABLES_BY_NAME.get('email_contact_links')
  if (!messageSpec || !companyLinkSpec || !contactLinkSpec) {
    console.error('[email-sync-backfill] OWNED_TABLES missing email entries')
    return EMPTY
  }

  let messagesEnqueued = 0
  let companyLinksEnqueued = 0
  let contactLinksEnqueued = 0
  let skipped = 0

  // ── messages first (FK parent) ────────────────────────────────────────────
  const messages = db
    .prepare("SELECT * FROM email_messages WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of messages) {
    try {
      enqueueOne(db, deviceId, userId, messageSpec, 'email_messages', row, projectMessage(row))
      messagesEnqueued++
    } catch (err) {
      console.error(`[email-sync-backfill] failed message ${String(row['id'])}:`, err)
      skipped++
    }
  }

  // ── company links ─────────────────────────────────────────────────────────
  const companyLinks = db
    .prepare("SELECT * FROM email_company_links WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of companyLinks) {
    try {
      enqueueOne(db, deviceId, userId, companyLinkSpec, 'email_company_links', row, row)
      companyLinksEnqueued++
    } catch (err) {
      console.error('[email-sync-backfill] failed company link:', err)
      skipped++
    }
  }

  // ── contact links ─────────────────────────────────────────────────────────
  const contactLinks = db
    .prepare("SELECT * FROM email_contact_links WHERE lamport = '0'")
    .all() as Array<Record<string, unknown>>
  for (const row of contactLinks) {
    try {
      enqueueOne(db, deviceId, userId, contactLinkSpec, 'email_contact_links', row, row)
      contactLinksEnqueued++
    } catch (err) {
      console.error('[email-sync-backfill] failed contact link:', err)
      skipped++
    }
  }

  console.log(
    `[email-sync-backfill] messages=${messagesEnqueued} ` +
      `companyLinks=${companyLinksEnqueued} contactLinks=${contactLinksEnqueued} skipped=${skipped}`,
  )
  return { messagesEnqueued, companyLinksEnqueued, contactLinksEnqueued, skipped }
}

/**
 * Lean, truncated projection of an email_messages row for the outbox payload.
 * Sends only the columns mirrored into Postgres (schema/email.ts) — drops
 * account_id, provider ids, reply_to, artifact_id, updated_at — and truncates
 * body_text. user_id is intentionally omitted; the gateway stamps it from JWT.
 */
function projectMessage(row: Record<string, unknown>): Record<string, unknown> {
  const body = row['body_text']
  return {
    id: row['id'],
    thread_id: row['thread_id'] ?? null,
    direction: row['direction'],
    subject: row['subject'] ?? null,
    from_name: row['from_name'] ?? null,
    from_email: row['from_email'],
    snippet: row['snippet'] ?? null,
    body_text:
      typeof body === 'string' && body.length > BODY_TEXT_CAP ? body.slice(0, BODY_TEXT_CAP) : body ?? null,
    sent_at: row['sent_at'] ?? null,
    received_at: row['received_at'] ?? null,
    labels_json: row['labels_json'] ?? null,
    is_unread: row['is_unread'] ?? 0,
    has_attachments: row['has_attachments'] ?? 0,
    created_at: row['created_at'],
  }
}

/**
 * One row, one transaction: mint a lamport, bump the SQLite row's lamport
 * column (so re-runs skip it), and insert the outbox entry with the supplied
 * payload. `pkRow` carries the primary-key values used for the UPDATE and
 * encodeRowId; `payloadRow` is what actually ships to Neon (projected /
 * truncated for messages, the raw row for the link tables).
 */
function enqueueOne(
  db: import('better-sqlite3').Database,
  deviceId: string,
  userId: string,
  spec: OwnedTableSpec,
  tableName: string,
  pkRow: Record<string, unknown>,
  payloadRow: Record<string, unknown>,
): void {
  const tx = db.transaction(() => {
    const lamport = nextLamport(db, deviceId)
    const pkClause = spec.primaryKey.map((c) => `${c} = ?`).join(' AND ')
    const pkValues = spec.primaryKey.map((c) => pkRow[c])
    db.prepare(`UPDATE ${tableName} SET lamport = ? WHERE ${pkClause}`).run(lamport, ...pkValues)

    const stampedRow = { ...payloadRow, lamport }
    const rowId = encodeRowId(spec, { ...pkRow, lamport })
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, deviceId, tableName, rowId, 'insert', JSON.stringify(stampedRow), lamport)
  })
  tx()
}

/**
 * Fire-and-forget launch backfill (3s after launch, matching the memo
 * pattern) so the SyncAgent has settled its device id / clock first.
 */
export function backfillEmailsForSyncOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillEmailsForSync(userId)
    } catch (err) {
      console.error('[email-sync-backfill] unexpected launch failure:', err)
    }
  }, 3000)
}

/**
 * Run after a Gmail ingest pass so freshly-ingested emails sync promptly
 * (rather than waiting for the next launch). Idempotent and cheap when there's
 * nothing new (zero rows at lamport='0').
 */
export function backfillEmailsAfterIngest(userId: string | null): EmailBackfillResult {
  try {
    return backfillEmailsForSync(userId)
  } catch (err) {
    console.error('[email-sync-backfill] unexpected post-ingest failure:', err)
    return EMPTY
  }
}
