import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Hits the real dev Neon DB; rows are TEST_PREFIX-tagged and cleaned in afterAll.
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

const TEST_PREFIX = `test-sc-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
const createdUserIds: string[] = []

afterAll(async () => {
  // Break the users↔firms FK cycle before the cascade delete.
  if (createdUserIds.length > 0) {
    await db
      .update(schema.users)
      .set({ firmId: null, invitedByUserId: null })
      .where(inArray(schema.users.id, createdUserIds))
  }
  await cleanup.cleanup()
  await app.close()
})

async function mintJwt(o: { userId: string; firmId: string; role: 'admin' | 'member' }) {
  return signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: o.userId,
    sid: TEST_PREFIX + 'sess-' + o.userId,
    device: TEST_PREFIX + 'dev',
    scope: ['user'],
    firm_id: o.firmId,
    role: o.role,
  })
}

// One firm with an admin + a member, used by every test below.
const firmId = TEST_PREFIX + createId().slice(0, 8)
const adminId = TEST_PREFIX + createId().slice(0, 8)
const memberId = TEST_PREFIX + createId().slice(0, 8)

async function seed(): Promise<{ adminJwt: string; memberJwt: string }> {
  await db.insert(schema.firms).values({
    id: firmId,
    name: 'SC Test Firm',
    slug: (TEST_PREFIX + 'scfirm').replace(/_/g, '-').toLowerCase(),
  })
  // firm_settings cascade-deletes with the firm; track the firm + users for cleanup.
  cleanup.track(schema.firms, schema.firms.id, firmId)
  for (const [id, role] of [
    [adminId, 'admin'],
    [memberId, 'member'],
  ] as const) {
    await db.insert(schema.users).values({
      id,
      googleSub: 'sub-' + id,
      email: `${id}@example.com`,
      displayName: id,
      firmId,
      role,
    })
    createdUserIds.push(id)
    cleanup.track(schema.users, schema.users.id, id)
    cleanup.track(schema.auditLog, schema.auditLog.userId, id)
  }
  return {
    adminJwt: await mintJwt({ userId: adminId, firmId, role: 'admin' }),
    memberJwt: await mintJwt({ userId: memberId, firmId, role: 'member' }),
  }
}

describe('firm storage-config (two-tier storage, Slice 2)', () => {
  test('admin sets a relative Drive spec; member inherits it via GET', async () => {
    const { adminJwt, memberJwt } = await seed()

    // Before any PUT, GET returns null (firm hasn't set a shared folder yet).
    const empty = await app.inject({
      method: 'GET',
      url: '/firms/me/storage-config',
      headers: { authorization: `Bearer ${memberJwt}` },
    })
    expect(empty.statusCode).toBe(200)
    expect((empty.json() as { storage_config: unknown }).storage_config).toBeNull()

    // Admin PUTs the shared spec.
    const put = await app.inject({
      method: 'PUT',
      url: '/firms/me/storage-config',
      headers: { authorization: `Bearer ${adminJwt}`, 'content-type': 'application/json' },
      payload: { provider: 'gdrive', rel_path: 'Shared drives/Cyggie/Meeting Notes' },
    })
    expect(put.statusCode).toBe(200)
    expect((put.json() as { storage_config: { rel_path: string } }).storage_config.rel_path).toBe(
      'Shared drives/Cyggie/Meeting Notes',
    )

    // Member now inherits exactly what the admin set.
    const got = await app.inject({
      method: 'GET',
      url: '/firms/me/storage-config',
      headers: { authorization: `Bearer ${memberJwt}` },
    })
    expect(got.statusCode).toBe(200)
    const body = got.json() as {
      storage_config: { provider: string; rel_path: string }
      updated_by_user_id: string
    }
    expect(body.storage_config).toEqual({
      provider: 'gdrive',
      rel_path: 'Shared drives/Cyggie/Meeting Notes',
    })
    expect(body.updated_by_user_id).toBe(adminId)
  })

  test('member cannot set the shared config (403 ADMIN_REQUIRED)', async () => {
    const memberJwt = await mintJwt({ userId: memberId, firmId, role: 'member' })
    const res = await app.inject({
      method: 'PUT',
      url: '/firms/me/storage-config',
      headers: { authorization: `Bearer ${memberJwt}`, 'content-type': 'application/json' },
      payload: { provider: 'gdrive', rel_path: 'Shared drives/Cyggie/Meeting Notes' },
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error?: { code?: string } }).error?.code).toBe('ADMIN_REQUIRED')
  })

  test('path-traversal rel_path is rejected (400)', async () => {
    const adminJwt = await mintJwt({ userId: adminId, firmId, role: 'admin' })
    for (const bad of ['../escape', '/absolute/path', 'a/../../b', 'a\\b']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/firms/me/storage-config',
        headers: { authorization: `Bearer ${adminJwt}`, 'content-type': 'application/json' },
        payload: { provider: 'gdrive', rel_path: bad },
      })
      expect(res.statusCode, `rel_path "${bad}" should be rejected`).toBe(400)
    }
  })
})
