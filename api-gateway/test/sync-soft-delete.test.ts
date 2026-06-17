import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Phase 3 — soft-delete propagates in multiplayer. A user "Delete" is a field-LWW
// UPDATE setting deleted_at; it syncs to teammates via the normal merge path (a
// hard delete couldn't be pulled). Restore clears deleted_at and wins by lamport.

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-softdel-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

const firmId = TEST_PREFIX + 'firm'
let userA = ''
let userB = ''

async function setupFirm(): Promise<void> {
  await db.insert(schema.firms).values({ id: firmId, name: 'Red Swan', slug: TEST_PREFIX + 'rs' })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  for (const label of ['A', 'B']) {
    const id = TEST_PREFIX + label
    await db.insert(schema.users).values({
      id, googleSub: 'sub-' + id, email: `${id}@example.com`, displayName: 'User ' + label, firmId,
    })
    cleanup.track(schema.users, schema.users.id, id)
    if (label === 'A') userA = id
    else userB = id
  }
}

function jwt(userId: string): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId, sid: TEST_PREFIX + 's-' + userId, device: TEST_PREFIX + 'd-' + userId,
    scope: ['user'], firm_id: firmId, role: 'member',
  })
}

function baseCompany(id: string, userId: string, lamport: string): Record<string, unknown> {
  return {
    id, user_id: userId, canonical_name: 'Acme', normalized_name: 'acme-' + id,
    status: 'active', entity_type: 'unknown', include_in_companies_view: 0,
    classification_source: 'auto', lamport,
  }
}

let outboxCounter = 0
async function push(token: string, entry: Record<string, unknown>): Promise<{ acked: number[]; rejected: unknown[] }> {
  const res = await app.inject({
    method: 'POST', url: '/sync/push', headers: { authorization: `Bearer ${token}` },
    payload: { deviceId: TEST_PREFIX + 'dev', batch: [{ outboxId: ++outboxCounter, ...entry }] },
  })
  expect(res.statusCode).toBe(200)
  return res.json()
}

describe('soft-delete + restore propagate across a firm', () => {
  test('A soft-deletes a company → B pulls the row with deleted_at set; restore clears it', async () => {
    await setupFirm()
    const tokenA = await jwt(userA)
    const tokenB = await jwt(userB)
    const id = TEST_PREFIX + 'co1'
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)

    // A creates the company.
    const ins = await push(tokenA, { table: 'org_companies', op: 'insert', rowId: id, payload: baseCompany(id, userA, '100'), lamport: '100' })
    expect(ins.acked).toHaveLength(1)

    // A soft-deletes it: a field-LWW UPDATE setting deleted_at.
    await push(tokenA, {
      table: 'org_companies', op: 'update', rowId: id,
      payload: { ...baseCompany(id, userA, '200'), deleted_at: '2026-06-17T12:00:00.000Z', deleted_by_user_id: userA, field_lamports: { deleted_at: '200', deleted_by_user_id: '200' } },
      lamport: '200',
    })
    const afterDelete = await db.query.orgCompanies.findFirst({ where: eq(schema.orgCompanies.id, id) })
    expect(afterDelete?.deletedAt).not.toBeNull()

    // B (same firm) pulls and RECEIVES the soft-deleted row (pull sends it so the
    // tombstone replicates; B's local reads filter deleted_at IS NULL).
    const pullB = await app.inject({ method: 'GET', url: '/sync/pull?since=0', headers: { authorization: `Bearer ${tokenB}` } })
    expect(pullB.statusCode).toBe(200)
    const pulled = (pullB.json().orgCompanies as Array<{ id: string; deletedAt: string | null }>).find((c) => c.id === id)
    expect(pulled).toBeTruthy()
    expect(pulled?.deletedAt).not.toBeNull()

    // Restore: a later UPDATE clears deleted_at (higher lamport wins).
    await push(tokenA, {
      table: 'org_companies', op: 'update', rowId: id,
      payload: { ...baseCompany(id, userA, '300'), deleted_at: null, deleted_by_user_id: null, field_lamports: { deleted_at: '300', deleted_by_user_id: '300' } },
      lamport: '300',
    })
    const afterRestore = await db.query.orgCompanies.findFirst({ where: eq(schema.orgCompanies.id, id) })
    expect(afterRestore?.deletedAt).toBeNull()
  })
})
