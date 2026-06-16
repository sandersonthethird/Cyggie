import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Stale-recording sweeper: meetings stuck at status='recording' for >1 hour
// get marked status='error'. Last-resort safety net for phones that crashed
// mid-upload + Deepgram webhooks that never landed.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { sweepStaleRecordingsOnce, sweepNoAudioRecordingsOnce } = await import(
  '../src/recording/stale-sweeper'
)

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-stale-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(() => cleanup.cleanup())

async function setupMeeting(args: {
  status: string
  ageHours: number
  // Defaults to a non-null path: the existing "stuck recording → error" cases
  // model audio that WAS uploaded but Deepgram never returned. Pass null to
  // model a pre-created/force-quit row with no audio.
  recordingPath?: string | null
}): Promise<{ userId: string; meetingId: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  await db.insert(schema.meetings).values({
    id: meetingId,
    userId,
    title: 'Stale Test',
    date: new Date(),
    status: args.status,
    recordingPath: args.recordingPath === undefined ? '/tmp/test.m4a' : args.recordingPath,
  })
  // Backdate createdAt so the row falls past the 1hr threshold (or doesn't).
  const backdated = new Date(Date.now() - args.ageHours * 60 * 60 * 1000)
  await db
    .update(schema.meetings)
    .set({ createdAt: backdated })
    .where(eq(schema.meetings.id, meetingId))
  cleanup.track(schema.meetings, schema.meetings.id, meetingId)
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

  // ── recordingPath guard: a live/just-created recording (no audio yet) must
  //    NOT be errored mid-recording, even past the 1hr threshold. ──
  test('does NOT error a recording with no recordingPath (live pre-created row)', async () => {
    const { meetingId } = await setupMeeting({
      status: 'recording',
      ageHours: 2,
      recordingPath: null,
    })
    const swept = await sweepStaleRecordingsOnce(env)
    expect(swept).not.toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.status).toBe('recording')
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

describe('no-audio orphan sweeper', () => {
  test('DELETES status=recording rows with no recordingPath older than 12h', async () => {
    const { meetingId } = await setupMeeting({
      status: 'recording',
      ageHours: 13,
      recordingPath: null,
    })
    const deleted = await sweepNoAudioRecordingsOnce(env)
    expect(deleted).toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row).toBeUndefined()
  })

  test('does NOT delete a no-recordingPath recording younger than 12h (long live recording)', async () => {
    const { meetingId } = await setupMeeting({
      status: 'recording',
      ageHours: 6,
      recordingPath: null,
    })
    const deleted = await sweepNoAudioRecordingsOnce(env)
    expect(deleted).not.toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.status).toBe('recording')
  })

  test('does NOT delete a row WITH a recordingPath (uploaded; the other sweeper owns it)', async () => {
    const { meetingId } = await setupMeeting({
      status: 'recording',
      ageHours: 13,
      recordingPath: '/tmp/has-audio.m4a',
    })
    const deleted = await sweepNoAudioRecordingsOnce(env)
    expect(deleted).not.toContain(meetingId)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row).toBeDefined()
  })
})
