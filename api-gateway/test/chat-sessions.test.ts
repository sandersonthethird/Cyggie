import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// T17a A2 — coverage for the new chat session list/detail/PATCH endpoints.
//
//   GET /chat/sessions          — paginated list with optional filters
//   GET /chat/sessions/:id      — detail + messages
//   PATCH /chat/sessions/:id    — rename / pin / archive with lamport LWW

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

const TEST_PREFIX = `test-chat-sess-${Date.now().toString(36)}-`
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

async function insertSession(opts: {
  userId: string
  contextId?: string
  contextKind?: 'meeting' | 'company' | 'contact' | 'crm' | 'search-results'
  contextLabel?: string | null
  title?: string | null
  lamport?: string
  isPinned?: boolean
  isArchived?: boolean
  lastMessageAt?: Date
}): Promise<string> {
  const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.chatSessions).values({
    id,
    userId: opts.userId,
    contextId: opts.contextId ?? id, // unique-per-row by default to avoid the
                                     // active-per-context unique index biting
                                     // when tests insert multiple sessions
    contextKind: opts.contextKind ?? 'crm',
    contextLabel: opts.contextLabel ?? null,
    title: opts.title ?? null,
    lamport: opts.lamport ?? '1',
    isPinned: opts.isPinned ? 1 : 0,
    isArchived: opts.isArchived ? 1 : 0,
    lastMessageAt: opts.lastMessageAt ?? new Date(),
    createdByUserId: opts.userId,
  })
  cleanup.track(schema.chatSessions, schema.chatSessions.id, id)
  return id
}

describe('GET /chat/sessions', () => {
  test('returns user sessions sorted by pinned DESC, lastMessageAt DESC', async () => {
    const { userId, jwt } = await setupUser()
    const older = await insertSession({
      userId,
      lastMessageAt: new Date('2026-01-01T00:00:00Z'),
    })
    const newer = await insertSession({
      userId,
      lastMessageAt: new Date('2026-02-01T00:00:00Z'),
    })
    const pinnedOld = await insertSession({
      userId,
      isPinned: true,
      lastMessageAt: new Date('2025-12-01T00:00:00Z'),
    })

    const res = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { sessions: Array<{ id: string; isPinned: boolean }>; total: number }
    const ids = body.sessions.map((s) => s.id)
    // Pinned first regardless of recency.
    expect(ids[0]).toBe(pinnedOld)
    // Then non-pinned ordered newest-first.
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
    expect(body.total).toBe(3)
  })

  test('archived sessions hidden by default; surfaced with includeArchived=true', async () => {
    const { userId, jwt } = await setupUser()
    const active = await insertSession({ userId })
    const archived = await insertSession({ userId, isArchived: true })

    const defaultRes = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const defaultIds = (defaultRes.json() as { sessions: Array<{ id: string }> }).sessions.map(
      (s) => s.id,
    )
    expect(defaultIds).toContain(active)
    expect(defaultIds).not.toContain(archived)

    const withArchived = await app.inject({
      method: 'GET',
      url: '/chat/sessions?includeArchived=true',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const allIds = (withArchived.json() as { sessions: Array<{ id: string }> }).sessions.map(
      (s) => s.id,
    )
    expect(allIds).toContain(active)
    expect(allIds).toContain(archived)
  })

  test('contextKind filter narrows the list', async () => {
    const { userId, jwt } = await setupUser()
    const meeting = await insertSession({ userId, contextKind: 'meeting' })
    const crm = await insertSession({ userId, contextKind: 'crm' })

    const res = await app.inject({
      method: 'GET',
      url: '/chat/sessions?contextKind=meeting',
      headers: { authorization: `Bearer ${jwt}` },
    })
    const ids = (res.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)
    expect(ids).toContain(meeting)
    expect(ids).not.toContain(crm)
  })

  test('does not leak other users\' sessions', async () => {
    const { userId: ownerId, jwt: ownerJwt } = await setupUser()
    const { userId: strangerId } = await setupUser()
    const owned = await insertSession({ userId: ownerId })
    const foreign = await insertSession({ userId: strangerId })

    const res = await app.inject({
      method: 'GET',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${ownerJwt}` },
    })
    const ids = (res.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id)
    expect(ids).toContain(owned)
    expect(ids).not.toContain(foreign)
  })
})

describe('GET /chat/sessions/:id', () => {
  test('returns session + messages in chronological order', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSession({ userId })
    await db.insert(schema.chatSessionMessages).values([
      {
        id: TEST_PREFIX + 'm1',
        sessionId,
        role: 'user',
        content: 'first',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: TEST_PREFIX + 'm2',
        sessionId,
        role: 'assistant',
        content: 'second',
        createdAt: new Date('2026-01-01T00:00:05Z'),
      },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      session: { id: string }
      messages: Array<{ role: string; content: string }>
    }
    expect(body.session.id).toBe(sessionId)
    expect(body.messages.map((m) => m.content)).toEqual(['first', 'second'])
  })

  test('404 on wrong-user (no existence leak)', async () => {
    const { userId: ownerId } = await setupUser()
    const { jwt: strangerJwt } = await setupUser()
    const sessionId = await insertSession({ userId: ownerId })

    const res = await app.inject({
      method: 'GET',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${strangerJwt}` },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /chat/sessions/:id', () => {
  test('happy path: rename + lamport advances + 200 returns updated row', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSession({ userId, lamport: '5', title: null })

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { title: 'My pricing chat', lamport: '6' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; title: string; lamport: string }
    expect(body.title).toBe('My pricing chat')
    expect(body.lamport).toBe('6')

    const row = await db.query.chatSessions.findFirst({
      where: eq(schema.chatSessions.id, sessionId),
    })
    expect(row?.title).toBe('My pricing chat')
    expect(row?.lamport).toBe('6')
    expect(row?.updatedByUserId).toBe(userId)
  })

  test('isPinned toggle persists as integer + returns boolean', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSession({ userId, lamport: '1', isPinned: false })

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { isPinned: true, lamport: '2' },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { isPinned: boolean }).isPinned).toBe(true)

    const row = await db.query.chatSessions.findFirst({
      where: eq(schema.chatSessions.id, sessionId),
    })
    expect(row?.isPinned).toBe(1)
  })

  test('archive sets is_active=0 implicitly so the unique-active-per-context index frees up', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSession({ userId, lamport: '1' })
    // Above insert sets isActive=1 by schema default.

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { isArchived: true, lamport: '2' },
    })
    expect(res.statusCode).toBe(200)

    const row = await db.query.chatSessions.findFirst({
      where: eq(schema.chatSessions.id, sessionId),
    })
    expect(row?.isArchived).toBe(1)
    expect(row?.isActive).toBe(0)
  })

  test('409 + current session body when incoming lamport <= stored', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSession({ userId, lamport: '10', title: 'original' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { title: 'stale-edit', lamport: '10' }, // equal → conflict
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { title: string; lamport: string }
    expect(body.title).toBe('original')
    expect(body.lamport).toBe('10')
  })

  test('400 when PATCH body has only lamport (no actual field to change)', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSession({ userId, lamport: '1' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { lamport: '2' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('404 on wrong-user', async () => {
    const { userId: ownerId } = await setupUser()
    const { jwt: strangerJwt } = await setupUser()
    const sessionId = await insertSession({ userId: ownerId, lamport: '1' })

    const res = await app.inject({
      method: 'PATCH',
      url: `/chat/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${strangerJwt}`, 'content-type': 'application/json' },
      payload: { title: 'hijack', lamport: '2' },
    })
    expect(res.statusCode).toBe(404)
  })
})
