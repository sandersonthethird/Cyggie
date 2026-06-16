import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Phase 1 multiplayer: org_companies is firm-shared with field-level LWW.
// Validates that (1) a teammate's /sync/pull receives a company another member
// pushed (firm-scope), and (2) concurrent edits to DIFFERENT fields of the same
// company both survive the gateway merge, while a same-field race resolves by
// lamport.

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

const TEST_PREFIX = `test-firmshare-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

const firmId = TEST_PREFIX + 'firm'
let userA = ''
let userB = ''

async function setupFirm(): Promise<void> {
  await db.insert(schema.firms).values({
    id: firmId,
    name: 'Red Swan',
    slug: TEST_PREFIX + 'redswan',
  })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  for (const label of ['A', 'B']) {
    const id = TEST_PREFIX + label
    await db.insert(schema.users).values({
      id,
      googleSub: 'sub-' + id,
      email: `${id}@example.com`,
      displayName: 'User ' + label,
      firmId,
    })
    cleanup.track(schema.users, schema.users.id, id)
    if (label === 'A') userA = id
    else userB = id
  }
}

function jwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device-' + userId,
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
}

function baseCompany(id: string, userId: string, lamport: string): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    canonical_name: 'Acme',
    normalized_name: 'acme-' + id,
    status: 'active',
    entity_type: 'unknown',
    include_in_companies_view: 0,
    classification_source: 'auto',
    lamport,
  }
}

let outboxCounter = 0

async function push(
  token: string,
  entry: { table: string; op: string; rowId: string; payload: Record<string, unknown>; lamport: string },
): Promise<{ acked: number[]; rejected: unknown[]; conflicts: unknown[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/sync/push',
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: TEST_PREFIX + 'dev', batch: [{ outboxId: ++outboxCounter, ...entry }] },
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('firm-shared org_companies + field-LWW', () => {
  test('teammate pulls a pushed company; concurrent diff-field edits both survive', async () => {
    await setupFirm()
    const tokenA = await jwt(userA)
    const tokenB = await jwt(userB)
    const companyId = TEST_PREFIX + 'co1'
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)

    // 1. A inserts the company.
    const ins = await push(tokenA, {
      table: 'org_companies',
      op: 'insert',
      rowId: companyId,
      payload: baseCompany(companyId, userA, '100'),
      lamport: '100',
    })
    expect(ins.acked).toHaveLength(1)
    expect(ins.rejected).toHaveLength(0)

    // Gateway stamped firm_id from A's JWT.
    const stamped = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(stamped?.firmId).toBe(firmId)

    // 2. B (same firm) pulls and receives A's company (firm-scope).
    const pullB = await app.inject({
      method: 'GET',
      url: '/sync/pull?since=0',
      headers: { authorization: `Bearer ${tokenB}` },
    })
    expect(pullB.statusCode).toBe(200)
    const pulled = pullB.json().orgCompanies as Array<{ id: string }>
    expect(pulled.some((c) => c.id === companyId)).toBe(true)

    // 3. Concurrent edits to DIFFERENT fields:
    //    A sets description (@200), B sets city (@201). Both carry the full row
    //    but each field_lamports map names only the column it changed.
    await push(tokenA, {
      table: 'org_companies',
      op: 'update',
      rowId: companyId,
      payload: {
        ...baseCompany(companyId, userA, '200'),
        description: 'A wrote this',
        field_lamports: { description: '200' },
      },
      lamport: '200',
    })
    await push(tokenB, {
      table: 'org_companies',
      op: 'update',
      rowId: companyId,
      payload: {
        ...baseCompany(companyId, userB, '201'),
        city: 'B-ville',
        field_lamports: { city: '201' },
      },
      lamport: '201',
    })

    const merged = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    // Both edits survived — field-LWW didn't clobber.
    expect(merged?.description).toBe('A wrote this')
    expect(merged?.city).toBe('B-ville')

    // 4. Same-field race: A @300 vs B @299 on description; higher lamport wins.
    await push(tokenB, {
      table: 'org_companies',
      op: 'update',
      rowId: companyId,
      payload: {
        ...baseCompany(companyId, userB, '299'),
        description: 'B loses',
        field_lamports: { description: '299' },
      },
      lamport: '299',
    })
    await push(tokenA, {
      table: 'org_companies',
      op: 'update',
      rowId: companyId,
      payload: {
        ...baseCompany(companyId, userA, '300'),
        description: 'A wins',
        field_lamports: { description: '300' },
      },
      lamport: '300',
    })
    const final = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(final?.description).toBe('A wins')
    expect(final?.city).toBe('B-ville') // untouched, still B's
  })

  test('SECURITY: a forged field_lamports key (not a real column) is ignored, no injection', async () => {
    const tokenA = await jwt(userA)
    const companyId = TEST_PREFIX + 'co-sec'
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, companyId)
    await push(tokenA, {
      table: 'org_companies',
      op: 'insert',
      rowId: companyId,
      payload: baseCompany(companyId, userA, '100'),
      lamport: '100',
    })

    // A malicious map names a bogus "column" with SQL-breaking characters at a
    // winning clock. It must NOT be interpolated into the UPDATE; the legit
    // `stage` change still applies and the table survives.
    const res = await push(tokenA, {
      table: 'org_companies',
      op: 'update',
      rowId: companyId,
      payload: {
        ...baseCompany(companyId, userA, '200'),
        stage: 'seed',
        field_lamports: {
          stage: '200',
          'evil" = (SELECT 1)--': '999999999999',
        },
      },
      lamport: '200',
    })
    expect(res.rejected).toHaveLength(0)

    const row = await db.query.orgCompanies.findFirst({
      where: eq(schema.orgCompanies.id, companyId),
    })
    expect(row?.stage).toBe('seed') // legit column applied
    expect(row?.canonicalName).toBe('Acme') // table intact, no injection damage
  })
})
