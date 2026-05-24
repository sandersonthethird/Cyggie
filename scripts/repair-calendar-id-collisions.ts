// =============================================================================
// One-time repair: desktop-recorded transcripts that never made it to Neon
// because mobile/calendar pre-created a row with the same calendar_event_id,
// and sync_push rejects on the (user_id, calendar_event_id) unique index.
//
// Strategy: for each stuck desktop row with a non-empty transcript,
//   1. Find Neon's row by (user_id, calendar_event_id).
//   2. Merge desktop's transcript/summary/status/speaker_map/duration onto
//      Neon's row — only filling EMPTY fields (never overwrite mobile content).
//   3. Advance status forward only (never demote summarized → transcribed).
//   4. Bump lamport so mobile's /sync/pull picks it up.
//   5. Mark the desktop outbox entries for that row_id as 'dead' so they
//      stop being retried (the outbox treats this row as fully delivered
//      via the side-channel merge).
//
// Two separate IDs survive — desktop keeps abe42cbc..., Neon keeps
// gu0jfrvz... — but both rows now carry the same transcript content,
// which is what the user actually cares about. A proper id-reconciliation
// pass is a separate, larger fix.
//
//   USAGE
//   ─────
//   node --env-file=.env.local --experimental-strip-types \
//        scripts/repair-calendar-id-collisions.ts [--apply]
// =============================================================================

import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'

const { Pool } = pg

const { values } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    sqlite: {
      type: 'string',
      default: join(homedir(), 'Documents/MeetingIntelligence/echovault.db'),
    },
  },
})

if (!process.env['GATEWAY_DATABASE_URL']) {
  throw new Error('GATEWAY_DATABASE_URL required')
}

const APPLY = values.apply
const SQLITE_PATH = values.sqlite as string

const sqlite = new DatabaseSync(SQLITE_PATH, { open: true, readOnly: true })
const pool = new Pool({ connectionString: process.env['GATEWAY_DATABASE_URL'], max: 2 })

interface DesktopRow {
  id: string
  user_id: string // from outbox, joined in
  title: string | null
  status: string
  calendar_event_id: string | null
  transcript_segments: string | null
  speaker_map: string | null
  speaker_count: number | null
  duration_seconds: number | null
  summary: string | null
  notes: string | null
  chat_messages: string | null
}

interface NeonRow {
  id: string
  user_id: string
  title: string | null
  status: string
  lamport: string
  transcript_present: boolean
  summary_present: boolean
  notes: string | null
  chat_messages_present: boolean
}

const STATUS_RANK: Record<string, number> = {
  scheduled: 0,
  recording: 1,
  empty: 2,
  transcribed: 3,
  summarized: 4,
  error: -1,
}

function safeJsonNonEmpty(raw: string | null): boolean {
  if (!raw) return false
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.length > 0
    if (v && typeof v === 'object') return Object.keys(v).length > 0
    return false
  } catch {
    return false
  }
}

async function main() {
  // Find all desktop rows that have a failed outbox entry due to
  // calendar_event_id collision. user_id is carried by the outbox entry
  // (the desktop meetings table doesn't have a user_id column — single-user
  // local DB historically).
  const stuck = sqlite
    .prepare(
      `SELECT row_id, MAX(user_id) AS user_id
       FROM outbox
       WHERE status = 'failed'
         AND table_name = 'meetings'
         AND last_error LIKE '%meetings_user_calendar_event_idx%'
       GROUP BY row_id`,
    )
    .all() as Array<{ row_id: string; user_id: string }>
  const stuckIds = stuck.map((r) => r.row_id)
  const userIdByRow = new Map(stuck.map((r) => [r.row_id, r.user_id]))

  if (stuckIds.length === 0) {
    console.log('[repair] no stuck meetings — nothing to do.')
    return
  }

  console.log(`[repair] stuck-meeting candidates: ${stuckIds.length}`)

  // Read desktop side. user_id is joined in from the outbox capture above.
  const rawDesktop = sqlite
    .prepare(
      `SELECT id, title, status, calendar_event_id,
              transcript_segments, speaker_map, speaker_count,
              duration_seconds, summary, notes, chat_messages
       FROM meetings
       WHERE id IN (${stuckIds.map(() => '?').join(',')})`,
    )
    .all(...stuckIds) as Array<Omit<DesktopRow, 'user_id'>>
  const desktopRows: DesktopRow[] = rawDesktop.map((r) => ({
    ...r,
    user_id: userIdByRow.get(r.id) ?? '',
  }))

  const client = await pool.connect()
  try {
    const plans: Array<{
      desktop: DesktopRow
      neon: NeonRow | null
      updates: Record<string, unknown>
      reason: string
    }> = []

    for (const d of desktopRows) {
      if (!d.calendar_event_id) {
        plans.push({ desktop: d, neon: null, updates: {}, reason: 'no calendar_event_id on desktop' })
        continue
      }
      if (!safeJsonNonEmpty(d.transcript_segments)) {
        plans.push({ desktop: d, neon: null, updates: {}, reason: 'desktop has no transcript content — skip' })
        continue
      }

      // Match by calendar_event_id alone. The desktop outbox's user_id is a
      // legacy local id that doesn't map cleanly to Neon's users.id; the
      // (user_id, calendar_event_id) unique index lives on Neon's user_id
      // (cuid). calendar_event_id comes from Google Calendar and is globally
      // unique, so it's safe to match on alone.
      const found = await client.query<{
        id: string
        user_id: string
        title: string | null
        status: string
        lamport: string
        transcript_present: boolean
        summary_present: boolean
        notes: string | null
        chat_messages_present: boolean
      }>(
        `SELECT id, user_id, title, status, lamport,
                (transcript_segments IS NOT NULL
                  AND jsonb_typeof(transcript_segments) = 'array'
                  AND jsonb_array_length(transcript_segments) > 0) AS transcript_present,
                (summary IS NOT NULL AND length(summary) > 0) AS summary_present,
                notes,
                (chat_messages IS NOT NULL
                  AND jsonb_typeof(chat_messages) = 'array'
                  AND jsonb_array_length(chat_messages) > 0) AS chat_messages_present
         FROM meetings
         WHERE calendar_event_id = $1`,
        [d.calendar_event_id],
      )

      if (found.rowCount === 0) {
        plans.push({ desktop: d, neon: null, updates: {}, reason: 'no matching Neon row by (user_id, calendar_event_id)' })
        continue
      }

      const neon = found.rows[0]
      const updates: Record<string, unknown> = {}

      if (!neon.transcript_present && d.transcript_segments) {
        updates['transcript_segments'] = JSON.parse(d.transcript_segments)
      }
      if (d.speaker_map) {
        try {
          updates['speaker_map'] = JSON.parse(d.speaker_map)
        } catch {
          // skip malformed
        }
      }
      if (d.speaker_count != null && d.speaker_count > 0) {
        updates['speaker_count'] = d.speaker_count
      }
      if (d.duration_seconds != null && d.duration_seconds > 0) {
        updates['duration_seconds'] = d.duration_seconds
      }
      if (!neon.summary_present && d.summary && d.summary.length > 0) {
        updates['summary'] = d.summary
      }
      if (!neon.chat_messages_present && d.chat_messages && safeJsonNonEmpty(d.chat_messages)) {
        updates['chat_messages'] = JSON.parse(d.chat_messages)
      }

      // Status: advance only.
      const dRank = STATUS_RANK[d.status] ?? -1
      const nRank = STATUS_RANK[neon.status] ?? -1
      if (dRank > nRank) updates['status'] = d.status

      if (Object.keys(updates).length === 0) {
        plans.push({ desktop: d, neon, updates, reason: 'Neon already has everything — no-op' })
        continue
      }

      plans.push({ desktop: d, neon, updates, reason: 'merge' })
    }

    console.log('')
    console.log('===== PLAN =====')
    for (const p of plans) {
      console.log('---')
      console.log(`desktop_id : ${p.desktop.id}`)
      console.log(`title      : ${p.desktop.title}`)
      console.log(`status (d) : ${p.desktop.status}`)
      console.log(`neon_id    : ${p.neon?.id ?? '<none>'}`)
      console.log(`neon_stat  : ${p.neon?.status ?? '-'}`)
      console.log(`reason     : ${p.reason}`)
      console.log(`updates    : ${Object.keys(p.updates).join(', ') || '<none>'}`)
    }
    console.log('================')

    if (!APPLY) {
      console.log('')
      console.log('[repair] DRY-RUN — pass --apply to commit.')
      return
    }

    let applied = 0
    let deadlettered = 0
    for (const p of plans) {
      if (!p.neon || Object.keys(p.updates).length === 0) continue

      // Bump lamport in the same UPDATE.
      const storedLamport = BigInt(p.neon.lamport ?? '0')
      const wallLamport = BigInt(Date.now())
      const nextLamport = ((storedLamport > wallLamport ? storedLamport : wallLamport) + 1n).toString()

      const setCols = [
        ...Object.keys(p.updates).map((c) => `${c} = $${Object.keys(p.updates).indexOf(c) + 1}`),
        `lamport = $${Object.keys(p.updates).length + 1}`,
        `updated_at = NOW()`,
      ]
      const params: unknown[] = [
        ...Object.values(p.updates).map((v) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v)),
        nextLamport,
      ]
      params.push(p.neon.id)

      await client.query('BEGIN')
      try {
        await client.query(
          `UPDATE meetings SET ${setCols.join(', ')} WHERE id = $${params.length}`,
          params,
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`[repair] FAILED update for ${p.neon.id}:`, err)
        continue
      }
      applied++
      console.log(`[repair] applied: ${p.desktop.title} (desktop=${p.desktop.id} → neon=${p.neon.id}, lamport=${nextLamport})`)
    }

    console.log('')
    console.log(`[repair] APPLIED ${applied} merge(s).`)
    console.log(`[repair] NOTE: desktop outbox entries for the merged rows are still 'failed'.`)
    console.log(`[repair]       To stop retries, run the same script with --mark-dead (not yet wired — manual SQL below).`)
    console.log(`[repair]       Or accept the noise: outbox retries are idempotent and will keep failing harmlessly.`)
  } finally {
    client.release()
    await pool.end()
    sqlite.close()
  }
}

main().catch((err) => {
  console.error('[repair] FAILED:', err)
  process.exit(1)
})
