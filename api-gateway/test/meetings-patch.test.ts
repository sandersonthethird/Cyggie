import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// PATCH /meetings/:id — partial update for notes with client-sourced lamport
// Last-Write-Wins. Matches the existing /sync/push contract.
//
// Coverage:
//   • happy path — notes update, lamport advances, 200 with new MeetingDetail
//   • stale lamport (incoming <= stored) → 409 + current MeetingDetail
//   • equal lamport also → 409 (must be STRICTLY greater)
//   • ownership 404 — patching another user's meeting
//   • missing notes/lamport in body → 400
//   • audit_log row inserted with size delta + lamport movement (no content)
//   • notes=null is permitted (clearing)

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-patch-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdMeetingIds: string[] = []
const createdAuditIds: number[] = []

afterAll(async () => {
  if (createdAuditIds.length > 0) {
    await db.delete(schema.auditLog).where(inArray(schema.auditLog.id, createdAuditIds))
  }
  if (createdMeetingIds.length > 0) {
    await db.delete(schema.meetings).where(inArray(schema.meetings.id, createdMeetingIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  createdUserIds.push(userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
  return { userId, jwt }
}

async function insertMeeting(opts: {
  userId: string
  lamport?: string
  notes?: string | null
}): Promise<string> {
  const id = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
  await db.insert(schema.meetings).values({
    id,
    userId: opts.userId,
    title: 'Patchable',
    date: new Date('2026-05-20T10:00:00Z'),
    status: 'scheduled',
    notes: opts.notes ?? null,
    lamport: opts.lamport ?? '1',
    createdByUserId: opts.userId,
  })
  createdMeetingIds.push(id)
  return id
}

describe('PATCH /meetings/:id', () => {
  test('happy path: notes update + lamport advances + audit log row', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting({ userId, lamport: '5', notes: 'old text' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { notes: 'new text', lamport: '6' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; notes: string; lamport: string }
    expect(body.notes).toBe('new text')
    expect(body.lamport).toBe('6')

    // DB state matches response
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.notes).toBe('new text')
    expect(row?.lamport).toBe('6')
    expect(row?.updatedByUserId).toBe(userId)

    // Audit log row written with size delta + lamport movement; no content.
    const audit = await db.query.auditLog.findFirst({
      where: and(
        eq(schema.auditLog.targetKind, 'meeting'),
        eq(schema.auditLog.targetId, meetingId),
      ),
      orderBy: desc(schema.auditLog.createdAt),
    })
    expect(audit?.eventType).toBe('meeting.notes.update')
    expect(audit?.actor).toBe('user')
    expect(audit?.userId).toBe(userId)
    const details = audit?.details as {
      fromLength?: number
      toLength?: number
      lamportFrom?: string
      lamportTo?: string
    }
    expect(details.fromLength).toBe('old text'.length)
    expect(details.toLength).toBe('new text'.length)
    expect(details.lamportFrom).toBe('5')
    expect(details.lamportTo).toBe('6')
    // The notes content itself MUST NOT appear in the audit row.
    expect(JSON.stringify(details)).not.toContain('new text')
    expect(JSON.stringify(details)).not.toContain('old text')

    if (audit?.id) createdAuditIds.push(audit.id)
  })

  test('stale lamport (incoming < stored) → 409 + current detail', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting({ userId, lamport: '10', notes: 'server wins' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { notes: 'client loses', lamport: '5' },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json() as { notes: string; lamport: string }
    expect(body.notes).toBe('server wins')
    expect(body.lamport).toBe('10')

    // DB unchanged
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.notes).toBe('server wins')
    expect(row?.lamport).toBe('10')
  })

  test('equal lamport also → 409 (must be strictly greater)', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting({ userId, lamport: '7', notes: 'baseline' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { notes: 'should not apply', lamport: '7' },
    })
    expect(res.statusCode).toBe(409)
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.notes).toBe('baseline')
  })

  test('404 when meeting belongs to another user', async () => {
    const owner = await setupUser()
    const intruder = await setupUser()
    const meetingId = await insertMeeting({ userId: owner.userId, lamport: '3' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: {
        authorization: `Bearer ${intruder.jwt}`,
        'content-type': 'application/json',
      },
      payload: { notes: 'sneaky', lamport: '99' },
    })
    expect(res.statusCode).toBe(404)

    // Owner's row unchanged.
    const row = await db.query.meetings.findFirst({ where: eq(schema.meetings.id, meetingId) })
    expect(row?.notes).toBeNull()
    expect(row?.lamport).toBe('3')
  })

  test('400 when body missing required fields', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting({ userId, lamport: '1' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { notes: 'forgot lamport' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('notes=null is permitted (clearing notes)', async () => {
    const { userId, jwt } = await setupUser()
    const meetingId = await insertMeeting({ userId, lamport: '4', notes: 'old' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { notes: null, lamport: '5' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { notes: string | null; lamport: string }
    expect(body.notes).toBeNull()
    expect(body.lamport).toBe('5')
  })

  test('401 without Bearer', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/meetings/any-id',
      headers: { 'content-type': 'application/json' },
      payload: { notes: 'x', lamport: '1' },
    })
    expect(res.statusCode).toBe(401)
  })
})
