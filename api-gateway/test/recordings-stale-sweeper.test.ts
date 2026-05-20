import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// Stale-recording sweeper: meetings stuck at status='recording' for >1 hour
// get marked status='error'. Last-resort safety net for phones that crashed
// mid-upload + Deepgram webhooks that never landed.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { sweepStaleRecordingsOnce } = await import('../src/recording/stale-sweeper')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-stale-${Date.now().toString(36)}-`
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

async function setupMeeting(args: {
  status: string
  ageHours: number
}): Promise<{ userId: string; meetingId: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  createdUserIds.push(userId)
  await db.insert(schema.meetings).values({
    id: meetingId,
    userId,
    title: 'Stale Test',
    date: new Date(),
    status: args.status,
  })
  // Backdate createdAt so the row falls past the 1hr threshold (or doesn't).
  const backdated = new Date(Date.now() - args.ageHours * 60 * 60 * 1000)
  await db
    .update(schema.meetings)
    .set({ createdAt: backdated })
    .where(eq(schema.meetings.id, meetingId))
  createdMeetingIds.push(meetingId)
  return { userId, meetingId }
}

describe('stale-recording sweeper', () => {
  test('marks status=recording meetings older than 1hr as error', async () => {
    const { meetingId } = await setupMeeting({ status: 'recording', ageHours: 2 })
    const swept = await sweepStaleRecordingsOnce(env)
    expect(swept).toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.status).toBe('error')
  })

  test('leaves status=recording meetings younger than 1hr alone', async () => {
    const { meetingId } = await setupMeeting({ status: 'recording', ageHours: 0.5 })
    const swept = await sweepStaleRecordingsOnce(env)
    expect(swept).not.toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.status).toBe('recording')
  })

  test('does not touch status=transcribed meetings of any age', async () => {
    const { meetingId } = await setupMeeting({ status: 'transcribed', ageHours: 5 })
    const swept = await sweepStaleRecordingsOnce(env)
    expect(swept).not.toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.status).toBe('transcribed')
  })

  test('does not touch status=error meetings (idempotent)', async () => {
    const { meetingId } = await setupMeeting({ status: 'error', ageHours: 5 })
    const swept = await sweepStaleRecordingsOnce(env)
    expect(swept).not.toContain(meetingId)
  })

  test('updates updated_at on swept rows', async () => {
    const { meetingId } = await setupMeeting({ status: 'recording', ageHours: 3 })
    // Backdate updated_at too so we can confirm sweeper bumps it.
    const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000)
    await db
      .update(schema.meetings)
      .set({ updatedAt: oldDate })
      .where(eq(schema.meetings.id, meetingId))
    const before = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    await sweepStaleRecordingsOnce(env)
    const after = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime())
  })
})
