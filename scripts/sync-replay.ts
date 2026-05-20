/**
 * sync-replay.ts — operational tool for the desktop SyncAgent's outbox.
 *
 * Phase 1.5a's writeWithSync wrapper logs every owned-row mutation into a
 * local SQLite `outbox` table; the SyncAgent drains pending rows to Neon and
 * marks them acked. After 5 ack failures from the gateway, a row gets
 * promoted to `status='dead'` and is skipped — needing manual investigation.
 *
 * Subcommands:
 *
 *   dump                          summary counts + recent rows (default)
 *   replay-dead    [--limit N]    flip dead → pending, reset attempts + error
 *   replay-failed  [--limit N]    flip failed → pending (be selective)
 *   wipe-dead                     DELETE all status='dead' rows
 *   wipe-all       --confirm      DELETE every outbox row (destructive)
 *   delete <id>                   DELETE one row by primary key
 *
 * Run with:
 *
 *   npx tsx scripts/sync-replay.ts                       # dump
 *   npx tsx scripts/sync-replay.ts replay-dead
 *   npx tsx scripts/sync-replay.ts wipe-all --confirm
 *
 * better-sqlite3 ABI: Cyggie's postinstall rebuilds better-sqlite3 for the
 * Electron Node ABI. tsx uses the system Node ABI; if you see
 * "NODE_MODULE_VERSION ... requires NODE_MODULE_VERSION ..." run
 * `npm rebuild better-sqlite3` first, then `npx @electron/rebuild -f -w
 * better-sqlite3 --buildFromSource` after you're done with the script so
 * the desktop boots cleanly again. (Same dance the `pnpm test` script does.)
 *
 * After replay-* the SyncAgent's next 5s tick picks up the rows and drains
 * them. No restart needed.
 */

import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const DB_PATH = join(homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')

interface OutboxRow {
  id: number
  user_id: string
  device_id: string
  table_name: string
  row_id: string
  op: string
  status: string
  attempts: number
  last_error: string | null
  created_at: string
  acked_at: string | null
}

function openDb(): Database.Database {
  if (!existsSync(DB_PATH)) {
    console.error(`✗ SQLite DB not found at ${DB_PATH}`)
    console.error('  Boot Cyggie at least once to materialize it.')
    process.exit(2)
  }
  return new Database(DB_PATH)
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

// ─── dump ────────────────────────────────────────────────────────────────────

function dump(db: Database.Database): void {
  const totals = db
    .prepare<[], { status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM outbox GROUP BY status`,
    )
    .all()
  const total = totals.reduce((a, r) => a + r.n, 0)

  console.log('─── outbox summary ───')
  console.log(`  total rows:  ${fmt(total)}`)
  for (const r of ['pending', 'failed', 'dead']) {
    const n = totals.find((x) => x.status === r)?.n ?? 0
    const icon = n === 0 ? '·' : r === 'dead' ? '✗' : r === 'failed' ? '!' : '•'
    console.log(`    ${icon} ${r.padEnd(8)} ${fmt(n)}`)
  }
  console.log()

  // sync_state — useful for confirming the agent is actually progressing.
  const state = db
    .prepare<[], { device_id: string; last_pushed_lamport: string; last_seen_at: string }>(
      `SELECT device_id, last_pushed_lamport, last_seen_at FROM sync_state`,
    )
    .all()
  if (state.length > 0) {
    console.log('─── sync_state ───')
    for (const s of state) {
      console.log(
        `  device ${s.device_id.slice(0, 8)}… last_pushed_lamport=${s.last_pushed_lamport} last_seen=${s.last_seen_at}`,
      )
    }
    console.log()
  }

  // Recent rows — most-recently-failed first (most actionable for ops).
  const recent = db
    .prepare<[], OutboxRow>(
      `SELECT id, user_id, device_id, table_name, row_id, op, status, attempts, last_error, created_at, acked_at
       FROM outbox
       WHERE status IN ('failed', 'dead')
       ORDER BY id DESC
       LIMIT 20`,
    )
    .all()
  if (recent.length > 0) {
    console.log('─── recent failed/dead (20 most recent) ───')
    for (const r of recent) {
      const err = (r.last_error ?? '').slice(0, 80).replace(/\s+/g, ' ')
      console.log(
        `  #${r.id}  ${r.status.padEnd(7)}  ${r.op.padEnd(6)}  ${r.table_name}/${r.row_id.slice(0, 8)}…  attempts=${r.attempts}  ${err}`,
      )
    }
    console.log()
  }

  if (total === 0) {
    console.log('  (outbox is empty)')
  }
}

// ─── replay-* ────────────────────────────────────────────────────────────────

function replay(
  db: Database.Database,
  fromStatus: 'dead' | 'failed',
  limit: number | null,
): void {
  // Take a snapshot first so we can report ids meaningfully.
  const target = db
    .prepare<[], { id: number }>(
      limit
        ? `SELECT id FROM outbox WHERE status = ? ORDER BY id ASC LIMIT ?`
        : `SELECT id FROM outbox WHERE status = ? ORDER BY id ASC`,
    )
    .all(limit ? [fromStatus, limit] : [fromStatus]) as { id: number }[]

  if (target.length === 0) {
    console.log(`  (no rows with status='${fromStatus}' to replay)`)
    return
  }

  const ids = target.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const update = db.prepare(
    `UPDATE outbox SET status='pending', attempts=0, last_error=NULL WHERE id IN (${placeholders})`,
  )
  const result = update.run(...ids)
  console.log(
    `✓ replayed ${result.changes} row(s) (status: ${fromStatus} → pending, attempts reset)`,
  )
  console.log('  the SyncAgent will pick them up on its next 5s drain tick.')
}

// ─── wipe ────────────────────────────────────────────────────────────────────

function wipeDead(db: Database.Database): void {
  const result = db.prepare(`DELETE FROM outbox WHERE status='dead'`).run()
  console.log(`✓ deleted ${result.changes} dead row(s) from outbox`)
}

function wipeAll(db: Database.Database, confirm: boolean): void {
  if (!confirm) {
    console.error('✗ wipe-all is destructive. Pass --confirm to proceed.')
    console.error(
      '  All pending/failed/dead rows will be deleted; any un-acked writes will NEVER reach Neon.',
    )
    process.exit(2)
  }
  const result = db.prepare(`DELETE FROM outbox`).run()
  console.log(`✓ deleted ${result.changes} row(s) from outbox (entire table cleared)`)
}

function deleteOne(db: Database.Database, id: number): void {
  const before = db
    .prepare<[number], OutboxRow>(`SELECT * FROM outbox WHERE id = ?`)
    .get(id)
  if (!before) {
    console.error(`✗ no outbox row with id=${id}`)
    process.exit(2)
  }
  const result = db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id)
  console.log(
    `✓ deleted #${id} (${before.status}, ${before.op} ${before.table_name}/${before.row_id})`,
  )
  console.log(`  changes=${result.changes}`)
}

// ─── arg parse + main ────────────────────────────────────────────────────────

function parseIntFlag(flag: string, defaultValue: number | null): number | null {
  const idx = process.argv.indexOf(flag)
  if (idx === -1) return defaultValue
  const v = process.argv[idx + 1]
  if (!v) return defaultValue
  const n = parseInt(v, 10)
  return Number.isFinite(n) && n > 0 ? n : defaultValue
}

function main(): void {
  const cmd = process.argv[2] ?? 'dump'
  const db = openDb()
  try {
    switch (cmd) {
      case 'dump':
        dump(db)
        break
      case 'replay-dead':
        replay(db, 'dead', parseIntFlag('--limit', null))
        break
      case 'replay-failed':
        replay(db, 'failed', parseIntFlag('--limit', null))
        break
      case 'wipe-dead':
        wipeDead(db)
        break
      case 'wipe-all':
        wipeAll(db, process.argv.includes('--confirm'))
        break
      case 'delete': {
        const id = parseInt(process.argv[3] ?? '', 10)
        if (!Number.isFinite(id)) {
          console.error('✗ delete requires a numeric id: `sync-replay delete 123`')
          process.exit(2)
        }
        deleteOne(db, id)
        break
      }
      default:
        console.error(`✗ unknown subcommand: ${cmd}`)
        console.error(
          '  valid: dump | replay-dead | replay-failed | wipe-dead | wipe-all | delete <id>',
        )
        process.exit(2)
    }
  } finally {
    db.close()
  }
}

main()
