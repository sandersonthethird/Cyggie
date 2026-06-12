import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// PATCH /notes/:id — partial edit (title / content) with client-sourced lamport
// Last-Write-Wins. Mirrors PATCH /meetings/:id and PATCH /contacts/:id.
//
// Coverage:
//   • happy path — content updates, lamport advances, 200 with new note
//   • title clearing (empty string → null)
//   • stale lamport (incoming < stored) → 409 + current note
//   • equal lamport also → 409 (must be STRICTLY greater)
//   • ownership 404 — patching another user's note
//   • missing lamport → 400; empty patch (no title/content) → 400 NOTE_PATCH_EMPTY
//   • far-future lamport → 400 LAMPORT_OUT_OF_RANGE
//   • 401 without Bearer

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

const TEST_PREFIX = `test-note-patch-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

async function setupUser(): Promise<{ userId: string; jwt: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, userId)
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

async function insertNote(opts: {
  userId: string
  lamport?: string
  title?: string | null
  content?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'note-' + createId().slice(0, 8)
  await db.insert(schema.notes).values({
    id,
    userId: opts.userId,
    title: opts.title ?? null,
    content: opts.content ?? '',
    lamport: opts.lamport ?? '1',
    createdByUserId: opts.userId,
  })
  cleanup.track(schema.notes, schema.notes.id, id)
  return id
}

describe('PATCH /notes/:id', () => {
  test('happy path: content + title update, lamport advances', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '5', title: 'old', content: 'old body' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { title: 'new title', content: 'new body', lamport: '6' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { title: string; content: string; lamport: string }
    expect(body.title).toBe('new title')
    expect(body.content).toBe('new body')
    expect(body.lamport).toBe('6')

    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.content).toBe('new body')
    expect(row?.title).toBe('new title')
    expect(row?.lamport).toBe('6')
    expect(row?.updatedByUserId).toBe(userId)
  })

  test('empty title string clears the title (→ null)', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '2', title: 'has title', content: 'b' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { title: '   ', lamport: '3' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { title: string | null }).title).toBeNull()
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.title).toBeNull()
    // content untouched (not in patch)
    expect(row?.content).toBe('b')
  })

  test('stale lamport (incoming < stored) → 409 + current note', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '10', content: 'server wins' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { content: 'client loses', lamport: '5' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { content: string; lamport: string }
    expect(body.content).toBe('server wins')
    expect(body.lamport).toBe('10')

    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.content).toBe('server wins')
    expect(row?.lamport).toBe('10')
  })

  test('equal lamport also → 409 (must be strictly greater)', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '7', content: 'baseline' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { content: 'should not apply', lamport: '7' },
    })
    expect(res.statusCode).toBe(409)
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.content).toBe('baseline')
  })

  test('404 when note belongs to another user', async () => {
    const owner = await setupUser()
    const intruder = await setupUser()
    const noteId = await insertNote({ userId: owner.userId, lamport: '3', content: 'private' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${intruder.jwt}`, 'content-type': 'application/json' },
      payload: { content: 'sneaky', lamport: '99' },
    })
    expect(res.statusCode).toBe(404)
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.content).toBe('private')
    expect(row?.lamport).toBe('3')
  })

  test('400 when lamport missing', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '1' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { content: 'forgot lamport' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('400 NOTE_PATCH_EMPTY when neither title nor content provided', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '1', content: 'unchanged' })
    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { lamport: '2' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'NOTE_PATCH_EMPTY' } })
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.content).toBe('unchanged')
    expect(row?.lamport).toBe('1')
  })

  test('far-future lamport → 400 LAMPORT_OUT_OF_RANGE', async () => {
    const { userId, jwt } = await setupUser()
    const noteId = await insertNote({ userId, lamport: '5', content: 'baseline' })
    const huge = (2n ** 63n - 1n).toString()
    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { content: 'forge', lamport: huge },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'LAMPORT_OUT_OF_RANGE' } })
    const row = await db.query.notes.findFirst({ where: eq(schema.notes.id, noteId) })
    expect(row?.content).toBe('baseline')
    expect(row?.lamport).toBe('5')
  })

  test('401 without Bearer', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/notes/any-id',
      headers: { 'content-type': 'application/json' },
      payload: { content: 'x', lamport: '1' },
    })
    expect(res.statusCode).toBe(401)
  })
})
