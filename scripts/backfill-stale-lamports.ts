// =============================================================================
// One-time backfill: bump stale lamports on meetings whose Deepgram-webhook
// transcript write didn't advance the clock.
//
// Bug: api-gateway/src/recording/transcribe-job.ts wrote transcript_segments +
// updated_at directly to Neon without bumping lamport. Mobile's /sync/pull
// filters `WHERE lamport > since`, so those rows became invisible to mobile.
// Code fix is in place; this script repairs already-stuck rows.
//
//   USAGE
//   ─────
//   node --env-file=.env.local --experimental-strip-types \
//        scripts/backfill-stale-lamports.ts [--apply]
//
//   Without --apply: dry-run, prints affected rows + planned new lamport.
//   With --apply:    runs the UPDATE inside a single transaction.
// =============================================================================

import { parseArgs } from 'node:util'
import pg from 'pg'

const { Pool } = pg

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
  },
})

if (!process.env['GATEWAY_DATABASE_URL']) {
  throw new Error('GATEWAY_DATABASE_URL env var required (use --env-file=.env.local)')
}

const APPLY = values.apply

const pool = new Pool({
  connectionString: process.env['GATEWAY_DATABASE_URL'],
  max: 2,
})

// Stale signal: the webhook bumped updated_at to wall time when the transcript
// landed, but lamport was never advanced past its pre-recording value. So
// lamport (ms) ends up < updated_at (ms). For transcribed/empty rows this
// indicates a stuck row.
const SELECT_SQL = `
  SELECT
    id,
    user_id,
    title,
    status,
    lamport,
    updated_at,
    EXTRACT(EPOCH FROM updated_at)::bigint * 1000 AS updated_at_ms,
    GREATEST(
      CAST(lamport AS numeric),
      EXTRACT(EPOCH FROM updated_at) * 1000
    )::bigint + 1 AS next_lamport
  FROM meetings
  WHERE status IN ('transcribed', 'empty')
    AND CAST(lamport AS numeric) < EXTRACT(EPOCH FROM updated_at) * 1000
  ORDER BY updated_at DESC
`

const UPDATE_SQL = `
  UPDATE meetings
  SET lamport = (
    GREATEST(
      CAST(lamport AS numeric),
      EXTRACT(EPOCH FROM updated_at) * 1000
    )::bigint + 1
  )::text
  WHERE status IN ('transcribed', 'empty')
    AND CAST(lamport AS numeric) < EXTRACT(EPOCH FROM updated_at) * 1000
  RETURNING id, user_id, title, lamport
`

async function main() {
  const client = await pool.connect()
  try {
    console.log(`[backfill] connected. mode = ${APPLY ? 'APPLY' : 'DRY-RUN'}`)

    const preview = await client.query<{
      id: string
      user_id: string
      title: string | null
      status: string
      lamport: string
      updated_at: Date
      updated_at_ms: string
      next_lamport: string
    }>(SELECT_SQL)

    console.log(`[backfill] candidates: ${preview.rowCount}`)
    if (preview.rowCount === 0) {
      console.log('[backfill] nothing to do.')
      return
    }

    console.log('[backfill] sample (up to 20):')
    for (const row of preview.rows.slice(0, 20)) {
      console.log(
        `  • ${row.id}  status=${row.status}  ` +
        `title=${(row.title ?? '<null>').slice(0, 40)}  ` +
        `lamport: ${row.lamport} → ${row.next_lamport}  ` +
        `(updated_at_ms=${row.updated_at_ms})`,
      )
    }
    if (preview.rowCount > 20) {
      console.log(`  … and ${preview.rowCount - 20} more`)
    }

    if (!APPLY) {
      console.log('[backfill] DRY-RUN — pass --apply to commit.')
      return
    }

    await client.query('BEGIN')
    const upd = await client.query<{ id: string; user_id: string; title: string | null; lamport: string }>(
      UPDATE_SQL,
    )
    await client.query('COMMIT')
    console.log(`[backfill] APPLIED — ${upd.rowCount} rows updated.`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[backfill] FAILED:', err)
  process.exit(1)
})
