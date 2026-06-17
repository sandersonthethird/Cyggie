import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Phase 3 — admin hard-purge + tombstone registry. Purge removes the Neon row +
// writes a tombstone; the push handler then acks-and-drops a later write to the
// purged id (resurrection guard); teammates pull the tombstone. Non-admins 403.

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

const TEST_PREFIX = `test-purge-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

const firmId = TEST_PREFIX + 'firm'
let admin = ''
let member = ''

async function setupFirm(): Promise<void> {
  await db.insert(schema.firms).values({ id: firmId, name: 'RS', slug: TEST_PREFIX + 'rs' })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  for (const [label, role] of [['admin', 'admin'], ['member', 'member']] as const) {
    const id = TEST_PREFIX + label
    await db.insert(schema.users).values({
      id, googleSub: 'sub-' + id, email: `${id}@example.com`, displayName: label, firmId, role,
    })
    cleanup.track(schema.users, schema.users.id, id)
    if (label === 'admin') admin = id
    else member = id
  }
}

function jwt(userId: string, role: 'admin' | 'member'): Promise<string> {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId, sid: TEST_PREFIX + 's-' + userId, device: TEST_PREFIX + 'd-' + userId,
    scope: ['user'], firm_id: firmId, role,
  })
}

function baseCompany(id: string, userId: string, lamport: string): Record<string, unknown> {
  return {
    id, user_id: userId, canonical_name: 'Acme', normalized_name: 'acme-' + id, status: 'active',
    entity_type: 'unknown', include_in_companies_view: 0, classification_source: 'auto', lamport,
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

describe('admin purge + tombstone registry', () => {
  test('purge hard-deletes + tombstones; resurrection write is dropped; non-admin 403', async () => {
    await setupFirm()
    const tokenAdmin = await jwt(admin, 'admin')
    const tokenMember = await jwt(member, 'member')
    const id = TEST_PREFIX + 'co1'
    cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
    cleanup.track(schema.tombstones, schema.tombstones.entityId, id)

    await push(tokenAdmin, { table: 'org_companies', op: 'insert', rowId: id, payload: baseCompany(id, admin, '100'), lamport: '100' })

    // Non-admin purge → 403.
    const memberPurge = await app.inject({
      method: 'POST', url: `/admin/companies/${id}/purge`, headers: { authorization: `Bearer ${tokenMember}` },
    })
    expect(memberPurge.statusCode).toBe(403)
    expect(await db.query.orgCompanies.findFirst({ where: eq(schema.orgCompanies.id, id) })).toBeTruthy()

    // Admin purge → row gone + tombstone written.
    const adminPurge = await app.inject({
      method: 'POST', url: `/admin/companies/${id}/purge`, headers: { authorization: `Bearer ${tokenAdmin}` },
    })
    expect(adminPurge.statusCode).toBe(200)
    expect(adminPurge.json().purged).toBe(true)
    expect(await db.query.orgCompanies.findFirst({ where: eq(schema.orgCompanies.id, id) })).toBeFalsy()
    const tomb = await db.query.tombstones.findFirst({ where: eq(schema.tombstones.entityId, id) })
    expect(tomb?.entityType).toBe('company')
    expect(tomb?.firmId).toBe(firmId)

    // Resurrection guard: a later write to the purged id is acked-and-dropped.
    const res = await push(tokenAdmin, {
      table: 'org_companies', op: 'update', rowId: id,
      payload: { ...baseCompany(id, admin, '500'), description: 'back?', field_lamports: { description: '500' } },
      lamport: '500',
    })
    expect(res.acked).toHaveLength(1) // acked (so the client clears its outbox)
    expect(res.rejected).toHaveLength(0)
    expect(await db.query.orgCompanies.findFirst({ where: eq(schema.orgCompanies.id, id) })).toBeFalsy() // NOT resurrected

    // The member pulls the tombstone (firm-scoped).
    const pullB = await app.inject({ method: 'GET', url: '/sync/pull?since=0', headers: { authorization: `Bearer ${tokenMember}` } })
    expect(pullB.statusCode).toBe(200)
    const tombs = pullB.json().tombstones as Array<{ entityType: string; entityId: string }>
    expect(tombs.some((t) => t.entityId === id && t.entityType === 'company')).toBe(true)
  })
})
