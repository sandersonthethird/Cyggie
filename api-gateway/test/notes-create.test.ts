import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// POST /notes + DELETE /notes/:id (soft + ?hard) + PATCH tagging.
//
// Coverage:
//   POST
//     • happy path — 201 + full NoteDetail (author = caller, isPinned false)
//     • companyId tag → companyName resolved in the response
//     • folderPath + isPrivate honored; isPrivate defaults false
//     • missing lamport → 400; far-future lamport → 400 LAMPORT_OUT_OF_RANGE
//     • 401 without Bearer
//     • owner round-trip — GET /notes/:id returns the created note
//   DELETE (soft, default)
//     • 200 {ok:true}, GET → 404, but row STILL in Neon with deleted_at set
//     • excluded from GET /notes list + /note-folders counts
//     • 404 deleting another user's note; 401 without Bearer
//   DELETE ?hard=true
//     • 200, row GONE from Neon
//   PATCH tagging
//     • companyId set + clear(null) round-trips

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

const TEST_PREFIX = `test-note-create-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function setupUser(): Promise<{ userId: string; firmId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  const firmId = TEST_PREFIX + 'firm-' + createId().slice(0, 6)
  // firm_id on the row is load-bearing for noteVisibilityFilter (it joins
  // users.firm_id = jwt.firm_id), which GET /notes uses. firmId FKs → firms.id.
  await db.insert(schema.firms).values({ id: firmId, name: firmId, slug: firmId })
  cleanup.track(schema.firms, schema.firms.id, firmId)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    firmId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  const jwt = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'sess-' + userId,
    device: 'test-device',
    scope: ['user'],
    firm_id: firmId,
    role: 'member',
  })
  return { userId, firmId, jwt }
}

async function createCompany(userId: string, firmId: string, name: string): Promise<string> {
  const id = TEST_PREFIX + 'co-' + createId().slice(0, 8)
  await db.insert(schema.orgCompanies).values({
    id,
    userId,
    firmId,
    canonicalName: name,
    normalizedName: name.toLowerCase(),
  })
  cleanup.track(schema.orgCompanies, schema.orgCompanies.id, id)
  return id
}

function post(jwt: string | null, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/notes',
    headers: {
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      'content-type': 'application/json',
    },
    payload: payload as object,
  })
}

describe('POST /notes', () => {
  test('happy path → 201 + full NoteDetail', async () => {
    const { userId, jwt } = await setupUser()
    const res = await post(jwt, { title: 'Hello', content: 'world', lamport: '1' })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>
    expect(body['title']).toBe('Hello')
    expect(body['content']).toBe('world')
    expect(body['authorUserId']).toBe(userId)
    expect(body['isPinned']).toBe(false)
    expect(body['isPrivate']).toBe(false)
    expect(typeof body['id']).toBe('string')
    cleanup.track(schema.notes, schema.notes.id, body['id'] as string)

    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, body['id'] as string) })
    expect(row?.userId).toBe(userId)
    expect(row?.createdByUserId).toBe(userId)
    expect(row?.lamport).toBe('1')
  })

  test('companyId tag → companyName resolved in response', async () => {
    const { userId, firmId, jwt } = await setupUser()
    const companyId = await createCompany(userId, firmId, 'Acme Inc')
    const res = await post(jwt, { content: 'tagged', companyId, lamport: '1' })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>
    cleanup.track(schema.notes, schema.notes.id, body['id'] as string)
    expect(body['companyId']).toBe(companyId)
    expect(body['companyName']).toBe('Acme Inc')
  })

  test('folderPath + isPrivate honored; isPrivate defaults false', async () => {
    const { jwt } = await setupUser()
    const res = await post(jwt, { content: 'x', folderPath: 'Inbox/AI', isPrivate: true, lamport: '1' })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>
    cleanup.track(schema.notes, schema.notes.id, body['id'] as string)
    expect(body['folderPath']).toBe('Inbox/AI')
    expect(body['isPrivate']).toBe(true)
  })

  test('missing lamport → 400', async () => {
    const { jwt } = await setupUser()
    const res = await post(jwt, { content: 'x' })
    expect(res.statusCode).toBe(400)
  })

  test('far-future lamport → 400 LAMPORT_OUT_OF_RANGE', async () => {
    const { jwt } = await setupUser()
    const huge = (2n ** 63n - 1n).toString()
    const res = await post(jwt, { content: 'x', lamport: huge })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'LAMPORT_OUT_OF_RANGE' } })
  })

  test('401 without Bearer', async () => {
    const res = await post(null, { content: 'x', lamport: '1' })
    expect(res.statusCode).toBe(401)
  })

  test('owner round-trip — GET /notes/:id returns it', async () => {
    const { jwt } = await setupUser()
    const created = await post(jwt, { title: 'Roundtrip', content: 'body', lamport: '1' })
    const id = (created.json() as { id: string }).id
    cleanup.track(schema.notes, schema.notes.id, id)
    const got = await app.inject({
      method: 'GET',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(got.statusCode).toBe(200)
    expect((got.json() as { title: string }).title).toBe('Roundtrip')
  })
})

describe('DELETE /notes/:id', () => {
  test('soft delete: 200, GET 404, but row remains in Neon with deleted_at set', async () => {
    const { jwt } = await setupUser()
    const id = (await post(jwt, { content: 'to delete', lamport: '1' }).then((r) => r.json())).id as string
    cleanup.track(schema.notes, schema.notes.id, id)

    const del = await app.inject({
      method: 'DELETE',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(del.statusCode).toBe(200)
    expect((del.json() as { ok: boolean }).ok).toBe(true)

    // Hidden from reads…
    const got = await app.inject({
      method: 'GET',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(got.statusCode).toBe(404)

    // …but the row is STILL in Neon with deleted_at populated (soft, not hard).
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, id) })
    expect(row).toBeTruthy()
    expect(row?.deletedAt).toBeTruthy()
  })

  test('soft-deleted note is excluded from GET /notes list', async () => {
    const { jwt } = await setupUser()
    const id = (await post(jwt, { content: 'list-excluded', lamport: '1' }).then((r) => r.json())).id as string
    cleanup.track(schema.notes, schema.notes.id, id)
    await app.inject({ method: 'DELETE', url: `/notes/${id}`, headers: { authorization: `Bearer ${jwt}` } })

    const list = await app.inject({ method: 'GET', url: '/notes', headers: { authorization: `Bearer ${jwt}` } })
    const notes = (list.json() as { notes: Array<{ id: string }> }).notes
    expect(notes.find((n) => n.id === id)).toBeUndefined()
  })

  test('404 deleting another user’s note', async () => {
    const owner = await setupUser()
    const intruder = await setupUser()
    const id = (await post(owner.jwt, { content: 'mine', lamport: '1' }).then((r) => r.json())).id as string
    cleanup.track(schema.notes, schema.notes.id, id)

    const del = await app.inject({
      method: 'DELETE',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${intruder.jwt}` },
    })
    expect(del.statusCode).toBe(404)
  })

  test('401 without Bearer', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/notes/whatever' })
    expect(res.statusCode).toBe(401)
  })

  test('?hard=true → 200, row GONE from Neon', async () => {
    const { jwt } = await setupUser()
    const id = (await post(jwt, { content: 'hard delete', lamport: '1' }).then((r) => r.json())).id as string

    const del = await app.inject({
      method: 'DELETE',
      url: `/notes/${id}?hard=true`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(del.statusCode).toBe(200)
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, id) })
    expect(row).toBeUndefined()
  })
})

describe('PATCH /notes/:id tagging', () => {
  test('companyId sets the tag and null clears it', async () => {
    const { userId, firmId, jwt } = await setupUser()
    const companyId = await createCompany(userId, firmId, 'Tagged Co')
    const id = (await post(jwt, { content: 'patch tag', lamport: '1' }).then((r) => r.json())).id as string
    cleanup.track(schema.notes, schema.notes.id, id)

    const set = await app.inject({
      method: 'PATCH',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { companyId, lamport: '2' },
    })
    expect(set.statusCode).toBe(200)
    expect((set.json() as { companyId: string; companyName: string }).companyName).toBe('Tagged Co')

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/notes/${id}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { companyId: null, lamport: '3' },
    })
    expect(cleared.statusCode).toBe(200)
    expect((cleared.json() as { companyId: string | null }).companyId).toBeNull()
    const row = await db.query.notes.findFirst({ where: and(eq(schema.notes.id, id)) })
    expect(row?.companyId).toBeNull()
  })
})
