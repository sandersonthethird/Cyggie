import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// On-boot reconciler: scans `meetings WHERE status='recording' AND
// deepgram_request_id IS NOT NULL`, polls Deepgram for completion, and
// finalizes (transcript persisted + push) any that are done.
//
// We stub global.fetch so the test never hits real Deepgram.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'
process.env['DEEPGRAM_WEBHOOK_SECRET'] = 'test-webhook-secret-at-least-16-chars'
if (!process.env['DEEPGRAM_API_KEY']) process.env['DEEPGRAM_API_KEY'] = 'test-deepgram-key'

vi.mock('../src/push/apns', () => ({
  initApnsClient: () => ({
    sendTranscriptionReady: async () => ({ ok: true, unregistered: [] }),
    sendTranscriptionFailed: async () => ({ ok: true, unregistered: [] }),
  }),
}))

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { reconcileStuckJobs } = await import('../src/recording/transcribe-job')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-reconcile-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(() => cleanup.cleanup())

async function setupStuckMeeting(args: {
  deepgramRequestId: string
}): Promise<{ userId: string; meetingId: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  // T32 PR-B: reconcileStuckJobs now requires per-user Deepgram key via
  // user_credentials (env fallback removed). Without a row the reconciler
  // silently skips the meeting → status stays 'recording' and assertions
  // for 'transcribed' / 'error' fail. Seed a placeholder key per user.
  await db.insert(schema.userCredentials).values({
    userId,
    provider: 'deepgram',
    value: 'test-stub-deepgram-key',
  })
  await db.insert(schema.meetings).values({
    id: meetingId,
    userId,
    title: 'Stuck Meeting',
    date: new Date(),
    status: 'recording',
    deepgramRequestId: args.deepgramRequestId,
  })
  cleanup.track(schema.meetings, schema.meetings.id, meetingId)
  return { userId, meetingId }
}

const fetchSpy = vi.spyOn(globalThis, 'fetch')
beforeEach(() => {
  fetchSpy.mockReset()
})

describe('reconcileStuckJobs', () => {
  test('completed Deepgram job → meeting flips to transcribed + segments persisted', async () => {
    const requestId = 'dg-reconcile-1-' + createId()
    const { meetingId } = await setupStuckMeeting({ deepgramRequestId: requestId })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: { duration: 60, channels: 1 },
          job_status: 'done',
          results: {
            channels: [{ alternatives: [{ transcript: 'Recovered.', words: [] }] }],
            utterances: [
              {
                start: 0,
                end: 2,
                confidence: 0.9,
                channel: 0,
                transcript: 'Recovered.',
                words: [],
                speaker: 0,
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const result = await reconcileStuckJobs(env)
    expect(result.checked).toBeGreaterThanOrEqual(1)

    const m = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(m?.status).toBe('transcribed')
    expect(m?.durationSeconds).toBe(60)
    expect((m?.transcriptSegments as unknown[]).length).toBe(1)
  })

  test('Deepgram 404 (job expired/never existed) → meeting marked error', async () => {
    const requestId = 'dg-reconcile-404-' + createId()
    const { meetingId } = await setupStuckMeeting({ deepgramRequestId: requestId })

    fetchSpy.mockResolvedValueOnce(
      new Response('not found', { status: 404 }),
    )

    await reconcileStuckJobs(env)
    const m = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(m?.status).toBe('error')
  })

  test('still-processing job → meeting left untouched (webhook will land)', async () => {
    const requestId = 'dg-reconcile-pending-' + createId()
    const { meetingId } = await setupStuckMeeting({ deepgramRequestId: requestId })

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ job_status: 'processing' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    await reconcileStuckJobs(env)
    const m = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(m?.status).toBe('recording')
  })
})
