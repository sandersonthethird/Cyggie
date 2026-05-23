/**
 * backfill-outbox.ts — emit outbox 'insert' entries for owned-table rows
 * that bypassed the withSync() wrapper before it was fixed.
 *
 * Context: a handful of cascading writes (notably the MEETING_TAG_SPEAKER_CONTACT
 * IPC handler's INSERT into meeting_speaker_contact_links, and a few merge /
 * dedup paths into meeting_company_links + contact_emails) used raw db.prepare()
 * instead of a wrapped repo function. As a result, those rows landed in SQLite
 * but never reached Neon. Mobile reads from Neon, so it couldn't see them —
 * the contact-detail "Meetings" tab + Last Touch stat broke for any speaker
 * tag that wasn't also in attendee_emails.
 *
 * The wrapper fix (this commit) prevents new rows from drifting. This script
 * is the one-time catch-up for everything that already exists.
 *
 * For each row in the target table:
 *   - encode the canonical outbox.row_id
 *   - if no pending/failed/dead/acked-pending outbox row exists for that
 *     (table, row_id), insert an 'insert' op with the row's current state
 *     as payload
 *   - mint a fresh lamport per row (monotonic) so the gateway's LWW resolver
 *     doesn't drop them
 *
 * Usage:
 *
 *   npx tsx scripts/backfill-outbox.ts meeting_speaker_contact_links
 *   npx tsx scripts/backfill-outbox.ts meeting_company_links --dry-run
 *   npx tsx scripts/backfill-outbox.ts contact_emails --user-id u_xxx
 *
 * Flags:
 *   --dry-run         show counts + a sample, don't write
 *   --user-id <id>    override (otherwise read from sync_state)
 *   --device-id <id>  override (otherwise read from sync_state)
 *
 * Same ABI caveat as sync-replay.ts: if `npm rebuild better-sqlite3` is
 * needed, rebuild before the script and run `@electron/rebuild` after.
 *
 * After running, the SyncAgent's next tick picks the rows up and drains
 * them to Neon. No desktop restart needed.
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { OWNED_TABLES_BY_NAME } from '../packages/db/src/sync/owned-tables'
import { encodeRowId } from '../packages/db/src/sync/encode-row-id'

const DB_PATH = join(homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')

interface Args {
  table: string
  dryRun: boolean
  userIdOverride: string | null
  deviceIdOverride: string | null
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  let dryRun = false
  let userIdOverride: string | null = null
  let deviceIdOverride: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry-run') dryRun = true
    else if (a === '--user-id') userIdOverride = argv[++i] ?? null
    else if (a === '--device-id') deviceIdOverride = argv[++i] ?? null
    else if (a.startsWith('--')) {
      console.error(`Unknown flag: ${a}`)
      process.exit(2)
    } else positional.push(a)
  }
  if (positional.length !== 1) {
    console.error('Usage: backfill-outbox.ts <table_name> [--dry-run] [--user-id X] [--device-id Y]')
    process.exit(2)
  }
  return {
    table: positional[0]!,
    dryRun,
    userIdOverride,
    deviceIdOverride,
  }
}

function openDb(): Database.Database {
  if (!existsSync(DB_PATH)) {
    console.error(`✗ SQLite DB not found at ${DB_PATH}`)
    process.exit(2)
  }
  return new Database(DB_PATH)
}

function resolveIdentity(
  db: Database.Database,
  args: Args,
): { userId: string; deviceId: string } {
  if (args.userIdOverride && args.deviceIdOverride) {
    return { userId: args.userIdOverride, deviceId: args.deviceIdOverride }
  }
  const row = db
    .prepare(
      `SELECT user_id, device_id FROM sync_state ORDER BY last_seen_at DESC LIMIT 1`,
    )
    .get() as { user_id: string; device_id: string } | undefined
  if (!row) {
    console.error(
      '✗ No sync_state row found. Pass --user-id and --device-id explicitly.',
    )
    process.exit(2)
  }
  return {
    userId: args.userIdOverride ?? row.user_id,
    deviceId: args.deviceIdOverride ?? row.device_id,
  }
}

// Mirror nextLamport semantics, but standalone so we don't drag in the
// module-level memo from sync-clock (which is process-shared with the
// desktop). For a one-shot script, seeded from sync_state + monotonic
// within this run is sufficient.
function makeLamportMinter(
  db: Database.Database,
  deviceId: string,
): () => string {
  const row = db
    .prepare(`SELECT last_pushed_lamport FROM sync_state WHERE device_id = ?`)
    .get(deviceId) as { last_pushed_lamport: string } | undefined
  let cursor = row ? BigInt(row.last_pushed_lamport) : 0n
  return () => {
    const now = BigInt(Date.now())
    const next = (cursor > now ? cursor : now) + 1n
    cursor = next
    return next.toString()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const spec = OWNED_TABLES_BY_NAME.get(args.table)
  if (!spec) {
    console.error(
      `✗ '${args.table}' is not in OWNED_TABLES. Available tables:`,
    )
    for (const k of OWNED_TABLES_BY_NAME.keys()) console.error(`    ${k}`)
    process.exit(2)
  }

  const db = openDb()
  const { userId, deviceId } = resolveIdentity(db, args)

  console.log(`─── backfill-outbox: ${args.table} ───`)
  console.log(`  user_id:    ${userId}`)
  console.log(`  device_id:  ${deviceId}`)
  console.log(`  dry-run:    ${args.dryRun}`)

  const allRows = db
    .prepare(`SELECT * FROM ${spec.table}`)
    .all() as Record<string, unknown>[]
  console.log(`  source rows: ${allRows.length}`)

  // Skip any row that already has a non-acked outbox entry for that
  // (table, row_id). Acked entries are deleted by the SyncAgent, so a
  // missing entry means either "already synced" OR "never synced." We
  // can't tell which without a remote check — so this is a best-effort
  // "don't double-enqueue" rather than a correctness guarantee. The
  // gateway's LWW + lamport ordering tolerates duplicate emissions
  // (same lamport → same row state → idempotent upsert).
  const existing = db
    .prepare(
      `SELECT row_id FROM outbox WHERE table_name = ? AND status IN ('pending','failed','dead')`,
    )
    .all(spec.table) as { row_id: string }[]
  const skip = new Set(existing.map((r) => r.row_id))
  console.log(`  in-outbox already: ${skip.size}`)

  const mintLamport = makeLamportMinter(db, deviceId)

  const insert = db.prepare(
    `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport, status)
     VALUES (?, ?, ?, ?, 'insert', ?, ?, 'pending')`,
  )

  let enqueued = 0
  let skipped = 0
  let sampleShown = 0

  const txn = db.transaction(() => {
    for (const row of allRows) {
      const rowId = encodeRowId(spec, row)
      if (skip.has(rowId)) {
        skipped++
        continue
      }
      if (args.dryRun) {
        if (sampleShown < 3) {
          console.log(`    [dry] would enqueue row_id=${rowId.slice(0, 80)}`)
          sampleShown++
        }
        enqueued++
        continue
      }
      const lamport = mintLamport()
      insert.run(
        userId,
        deviceId,
        spec.table,
        rowId,
        JSON.stringify(row),
        lamport,
      )
      enqueued++
    }
  })
  txn()

  console.log(`─── done ───`)
  console.log(`  enqueued: ${enqueued}`)
  console.log(`  skipped:  ${skipped} (already in outbox)`)
  if (!args.dryRun && enqueued > 0) {
    console.log(`  SyncAgent will drain these on its next tick (~5s).`)
  }
}

main().catch((err) => {
  console.error('✗ Failed:', err)
  process.exit(1)
})
