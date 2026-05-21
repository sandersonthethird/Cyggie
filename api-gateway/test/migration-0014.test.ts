import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Migration 0014: per-user uniqueness on meetings.calendar_event_id.
//
// We can't actually re-run CONCURRENTLY index swaps in the test DB on every
// run (they require running outside a tx and take a lock-window). Instead
// these tests verify the OBSERVABLE BEHAVIOR after the migration has been
// applied to the dev DB:
//
//   1. Two different users CAN insert meetings with the same calEventId
//      (new per-user index allows it)
//   2. Same user CANNOT insert two meetings with the same calEventId
//      (per-user uniqueness still enforced)
//   3. NULL calendar_event_id is permitted (partial index — WHERE NOT NULL)
//   4. The information_schema indexes record matches what we expect:
//      meetings_user_calendar_event_idx exists; meetings_calendar_event_idx
//      does not.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb, getPool } = await import('../src/db')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)
const pool = getPool(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-mig14-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdMeetingIds: string[] = []

afterAll(async () => {
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
})

async function makeUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
  })
  createdUserIds.push(id)
  return id
}

async function insertMeetingRaw(opts: {
  userId: string
  calendarEventId: string | null
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: 'mig-14 test',
    date: new Date('2026-05-21T10:00:00Z'),
    status: 'scheduled',
    calendarEventId: opts.calendarEventId,
  })
  createdMeetingIds.push(id)
  return id
}

describe('migration 0014: per-user calendar_event_id uniqueness', () => {
  test('two different users CAN insert meetings with the same calEventId', async () => {
    const alice = await makeUser()
    const bob = await makeUser()
    const shared = 'gcal-' + createId()

    const aliceMeeting = await insertMeetingRaw({ userId: alice, calendarEventId: shared })
    const bobMeeting = await insertMeetingRaw({ userId: bob, calendarEventId: shared })

    expect(aliceMeeting).not.toBe(bobMeeting)
  })

  test('same user CANNOT insert two meetings with the same calEventId', async () => {
    const userId = await makeUser()
    const calEventId = 'gcal-dup-' + createId()

    await insertMeetingRaw({ userId, calendarEventId: calEventId })

    let caught: unknown = null
    try {
      await insertMeetingRaw({ userId, calendarEventId: calEventId })
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    // Drizzle wraps pg errors — walk the chain to find the 23505 unique_violation.
    let code: string | undefined
    let cur: unknown = caught
    for (let i = 0; i < 5 && cur; i++) {
      if (typeof cur === 'object' && cur !== null && 'code' in cur) {
        const c = (cur as { code?: unknown }).code
        if (typeof c === 'string') code = c
      }
      cur = cur && typeof cur === 'object' && 'cause' in cur
        ? (cur as { cause?: unknown }).cause
        : null
    }
    expect(code).toBe('23505')
  })

  test('NULL calendar_event_id allowed (partial index)', async () => {
    const userId = await makeUser()
    const a = await insertMeetingRaw({ userId, calendarEventId: null })
    const b = await insertMeetingRaw({ userId, calendarEventId: null })
    // Two NULL rows coexist — partial index excludes them.
    expect(a).not.toBe(b)
  })

  test('information_schema: new index present, old index absent', async () => {
    const client = await pool.connect()
    try {
      const res = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
           WHERE tablename = 'meetings'
             AND indexname IN ('meetings_user_calendar_event_idx', 'meetings_calendar_event_idx')`,
      )
      const names = res.rows.map((r) => r.indexname).sort()
      expect(names).toContain('meetings_user_calendar_event_idx')
      expect(names).not.toContain('meetings_calendar_event_idx')
    } finally {
      client.release()
    }
  })
})
