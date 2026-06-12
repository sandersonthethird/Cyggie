import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Tests for POST /sync/push — the desktop SyncAgent's gateway endpoint.
// Validates LWW conflict resolution, drizzle-zod validation, composite-PK
// upserts, and cross-user defense-in-depth.

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

const TEST_PREFIX = `test-sync-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function insertUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName: id,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

async function mintJwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
}

function companyPayload(opts: { id: string; name: string; userId: string; lamport: string }) {
  return {
    id: opts.id,
    user_id: opts.userId,
    canonical_name: opts.name,
    normalized_name: opts.name.toLowerCase(),
    status: 'active',
    entity_type: 'unknown',
    include_in_companies_view: 0,
    classification_source: 'auto',
    lamport: opts.lamport,
  }
}

describe('POST /sync/push', () => {
  test('inserts a new owned-table row via UPSERT', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 1,
            table: 'org_companies',
            rowId: companyId,
            op: 'insert',
            payload: companyPayload({
              id: companyId,
              name: 'Acme ' + TEST_PREFIX,
              userId,
              lamport: '100',
            }),
            lamport: '100',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      acked: number[]
      rejected: Array<{ outboxId: number; reason: string }>
      conflicts: Array<{ outboxId: number; reason: string }>
    }
    expect(body.acked).toEqual([1])
    expect(body.rejected).toEqual([])
    expect(body.conflicts).toEqual([])

    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(row?.canonicalName).toBe('Acme ' + TEST_PREFIX)
    expect(row?.lamport).toBe('100')
  })

  test('updates an existing row via ON CONFLICT DO UPDATE', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)

    // Seed
    await db.insert(schema.orgCompanies).values({
      id: companyId,
      userId,
      canonicalName: 'Old ' + TEST_PREFIX,
      normalizedName: ('old ' + TEST_PREFIX).toLowerCase(),
      status: 'active',
      lamport: '50',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 2,
            table: 'org_companies',
            rowId: companyId,
            op: 'update',
            payload: companyPayload({
              id: companyId,
              name: 'New ' + TEST_PREFIX,
              userId,
              lamport: '200',
            }),
            lamport: '200',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { acked: number[] }
    expect(body.acked).toEqual([2])

    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(row?.canonicalName).toBe('New ' + TEST_PREFIX)
    expect(row?.lamport).toBe('200')
  })

  test('LWW: lower incoming lamport → conflict (ack but not applied)', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)

    // Seed at higher lamport
    await db.insert(schema.orgCompanies).values({
      id: companyId,
      userId,
      canonicalName: 'Newer ' + TEST_PREFIX,
      normalizedName: ('newer ' + TEST_PREFIX).toLowerCase(),
      status: 'active',
      lamport: '500',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 3,
            table: 'org_companies',
            rowId: companyId,
            op: 'update',
            payload: companyPayload({
              id: companyId,
              name: 'Loser ' + TEST_PREFIX,
              userId,
              lamport: '100',
            }),
            lamport: '100',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      acked: number[]
      conflicts: Array<{ outboxId: number; reason: string }>
    }
    expect(body.acked).toEqual([3])
    expect(body.conflicts).toHaveLength(1)
    expect(body.conflicts[0]?.outboxId).toBe(3)

    // Row unchanged
    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(row?.canonicalName).toBe('Newer ' + TEST_PREFIX)
    expect(row?.lamport).toBe('500')
  })

  test('drizzle-zod validation rejects malformed payload', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 4,
            table: 'org_companies',
            rowId: companyId,
            op: 'insert',
            payload: {
              // Missing required `canonical_name`, `normalized_name`.
              id: companyId,
              user_id: userId,
            },
            lamport: '10',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      acked: number[]
      rejected: Array<{ outboxId: number; reason: string }>
    }
    expect(body.acked).toEqual([])
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0]?.outboxId).toBe(4)
    expect(body.rejected[0]?.reason).toMatch(/validation/)
  })

  test('cross-user defense: payload user_id mismatch is rejected', async () => {
    const userA = await insertUser()
    const userB = await insertUser()
    const jwtA = await mintJwt(userA)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwtA}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 5,
            table: 'org_companies',
            rowId: companyId,
            op: 'insert',
            payload: companyPayload({
              id: companyId,
              name: 'CrossUser ' + TEST_PREFIX,
              userId: userB, // ← belongs to userB, but JWT is userA's
              lamport: '10',
            }),
            lamport: '10',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      rejected: Array<{ outboxId: number; reason: string }>
    }
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0]?.reason).toMatch(/user_id mismatch/)

    // No row created
    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(row).toBeUndefined()
  })

  test('composite-PK row_id (JSON) works for meeting_company_links', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    const meetingId = TEST_PREFIX + 'mtg-' + createId().slice(0, 8)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)
    cleanup.track(schema.meetings, schema.meetings.id, meetingId)

    // Seed parent rows
    await db.insert(schema.orgCompanies).values({
      id: companyId,
      userId,
      canonicalName: 'P ' + TEST_PREFIX,
      normalizedName: ('p ' + TEST_PREFIX).toLowerCase(),
      status: 'active',
    })
    await db.insert(schema.meetings).values({
      id: meetingId,
      userId,
      title: 'M ' + TEST_PREFIX,
      date: new Date(),
      durationSeconds: 1800,
      status: 'completed',
    })

    const rowId = JSON.stringify({ meeting_id: meetingId, company_id: companyId })

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 6,
            table: 'meeting_company_links',
            rowId,
            op: 'insert',
            payload: {
              meeting_id: meetingId,
              company_id: companyId,
              confidence: 1.0,
              linked_by: 'manual',
              lamport: '300',
            },
            lamport: '300',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      acked: number[]
      rejected: Array<{ outboxId: number; reason: string }>
      conflicts: Array<{ outboxId: number; reason: string }>
    }
    expect(body.acked).toEqual([6])

    const link = await db.query.meetingCompanyLinks.findFirst({
      where: eq(schema.meetingCompanyLinks.meetingId, meetingId),
    })
    expect(link?.companyId).toBe(companyId)
  })

  test('multi-entry batch processes all in order', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const c1 = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    const c2 = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    const c3 = TEST_PREFIX + 'co-' + createId().slice(0, 8)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c1)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c2)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, c3)

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 10,
            table: 'org_companies',
            rowId: c1,
            op: 'insert',
            payload: companyPayload({ id: c1, name: '1 ' + TEST_PREFIX, userId, lamport: '1' }),
            lamport: '1',
          },
          {
            outboxId: 11,
            table: 'org_companies',
            rowId: c2,
            op: 'insert',
            payload: companyPayload({ id: c2, name: '2 ' + TEST_PREFIX, userId, lamport: '2' }),
            lamport: '2',
          },
          {
            outboxId: 12,
            table: 'org_companies',
            rowId: c3,
            op: 'insert',
            payload: companyPayload({ id: c3, name: '3 ' + TEST_PREFIX, userId, lamport: '3' }),
            lamport: '3',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { acked: number[] }
    expect(body.acked.sort()).toEqual([10, 11, 12])
  })

  test('delete op removes the row', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const companyId = TEST_PREFIX + 'co-' + createId().slice(0, 8)

    await db.insert(schema.orgCompanies).values({
      id: companyId,
      userId,
      canonicalName: 'ToDelete ' + TEST_PREFIX,
      normalizedName: ('todelete ' + TEST_PREFIX).toLowerCase(),
      status: 'active',
      lamport: '10',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 20,
            table: 'org_companies',
            rowId: companyId,
            op: 'delete',
            payload: { id: companyId },
            lamport: '50',
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { acked: number[] }
    expect(body.acked).toEqual([20])

    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(row).toBeUndefined()
  })

  test('401 when no auth header', async () => {
    // Send a non-empty batch so Fastify's body-schema validation passes;
    // we want the auth check to fire and return 401.
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { 'content-type': 'application/json' },
      payload: {
        deviceId: 'x',
        batch: [
          {
            outboxId: 999,
            table: 'org_companies',
            rowId: 'doesnt-matter',
            op: 'insert',
            payload: { id: 'x' },
            lamport: '1',
          },
        ],
      },
    })
    expect(res.statusCode).toBe(401)
  })

  test('400 when batch is empty', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { deviceId: 'x', batch: [] },
    })
    // Zod min(1) on batch → 400
    expect(res.statusCode).toBe(400)
  })

  test('T8: lamport in the far future is rejected per-entry (siblings still apply)', async () => {
    const userId = await insertUser()
    const jwt = await mintJwt(userId)
    const goodCompanyId = TEST_PREFIX + 'co-good-' + createId().slice(0, 8)
    const badCompanyId = TEST_PREFIX + 'co-bad-' + createId().slice(0, 8)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, goodCompanyId)
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, badCompanyId)

    const huge = (2n ** 63n - 1n).toString()
    const res = await app.inject({
      method: 'POST',
      url: '/sync/push',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      payload: {
        deviceId: TEST_PREFIX + 'device',
        batch: [
          {
            outboxId: 100,
            table: 'org_companies',
            rowId: goodCompanyId,
            op: 'insert',
            payload: companyPayload({
              id: goodCompanyId,
              name: 'Good ' + TEST_PREFIX,
              userId,
              lamport: '100',
            }),
            lamport: '100',
          },
          {
            outboxId: 200,
            table: 'org_companies',
            rowId: badCompanyId,
            op: 'insert',
            payload: companyPayload({
              id: badCompanyId,
              name: 'Forged ' + TEST_PREFIX,
              userId,
              lamport: huge,
            }),
            lamport: huge,
          },
        ],
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      acked: number[]
      rejected: Array<{ outboxId: number; reason: string }>
    }
    // Good entry acked; forged entry rejected per-entry without aborting batch.
    expect(body.acked).toEqual([100])
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0]?.outboxId).toBe(200)
    expect(body.rejected[0]?.reason).toContain('LAMPORT_OUT_OF_RANGE')

    // Good row is in DB; forged row is NOT.
    const goodRow = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, goodCompanyId),
    })
    expect(goodRow?.canonicalName).toBe('Good ' + TEST_PREFIX)
    const badRow = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, badCompanyId),
    })
    expect(badRow).toBeUndefined()
  })
})
