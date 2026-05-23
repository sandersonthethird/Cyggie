import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// T17a A3 + A4 — non-Anthropic test coverage.
//
//   POST /chat/sessions               — idempotent find-or-create (A4)
//   POST /chat/sessions/:id/messages  — append + Claude reply + persist (A3)
//
// Per T23 posture (deferred Anthropic mocking), the A3 happy path is NOT
// exercised here. We test only the gate paths that don't touch Claude:
// auth, ownership, lamport conflict, body validation.

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

const TEST_PREFIX = `test-chat-a3a4-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdSessionIds: string[] = []

afterAll(async () => {
  if (createdSessionIds.length > 0) {
    await db
      .delete(schema.chatSessions)
      .where(inArray(schema.chatSessions.id, createdSessionIds))
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

async function insertSessionDirect(opts: {
  userId: string
  contextId?: string
  contextKind?: 'meeting' | 'company' | 'contact' | 'crm' | 'search-results'
  lamport?: string
}): Promise<string> {
  const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.chatSessions).values({
    id,
    userId: opts.userId,
    contextId: opts.contextId ?? id,
    contextKind: opts.contextKind ?? 'crm',
    contextLabel: null,
    title: null,
    lamport: opts.lamport ?? '1',
    lastMessageAt: new Date(),
    createdByUserId: opts.userId,
  })
  createdSessionIds.push(id)
  return id
}

// ──────────────────────────────────────────────────────────────────────────
// A4 — POST /chat/sessions (find-or-create)
// ──────────────────────────────────────────────────────────────────────────

describe('POST /chat/sessions — A4 find-or-create', () => {
  test('creates a new session and returns 201 when none exists', async () => {
    const { userId, jwt } = await setupUser()
    const contextId = TEST_PREFIX + 'ctx-' + createId().slice(0, 8)

    const res = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { contextKind: 'company', contextId, contextLabel: 'Acme Inc' },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json() as {
      id: string
      contextId: string
      contextKind: string
      isActive: boolean
      messageCount: number
    }
    expect(body.contextId).toBe(contextId)
    expect(body.contextKind).toBe('company')
    expect(body.isActive).toBe(true)
    expect(body.messageCount).toBe(0)
    createdSessionIds.push(body.id)
    void userId
  })

  test('returns existing session and 200 when active session exists for the same contextId', async () => {
    const { jwt, userId } = await setupUser()
    const contextId = TEST_PREFIX + 'ctx-' + createId().slice(0, 8)
    const existingId = await insertSessionDirect({
      userId,
      contextId,
      contextKind: 'company',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { contextKind: 'company', contextId, contextLabel: 'whatever' },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string }
    expect(body.id).toBe(existingId)
  })

  test('rejects unknown contextKind with 400', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { contextKind: 'invalid-kind', contextId: 'whatever' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('rejects empty contextId with 400', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { contextKind: 'company', contextId: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  test('rejects with 401 when no JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      payload: { contextKind: 'company', contextId: 'some-id' },
    })
    expect(res.statusCode).toBe(401)
  })

  test('different users with separate contextIds each get their own session', async () => {
    // In production, contextIds are per-user cuid2s (companyId/contactId/
    // meetingId all generated independently per user, so they don't
    // collide across users). The unique partial index on
    // chat_sessions_active_idx (where is_active=1) is on contextId
    // alone — sharing the SAME contextId across users would violate it,
    // but that's not a real production scenario today.
    const userA = await setupUser()
    const userB = await setupUser()
    const ctxA = TEST_PREFIX + 'ctx-a-' + createId().slice(0, 8)
    const ctxB = TEST_PREFIX + 'ctx-b-' + createId().slice(0, 8)

    const resA = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${userA.jwt}` },
      payload: { contextKind: 'company', contextId: ctxA },
    })
    expect(resA.statusCode).toBe(201)
    const aId = (resA.json() as { id: string }).id
    createdSessionIds.push(aId)

    const resB = await app.inject({
      method: 'POST',
      url: '/chat/sessions',
      headers: { authorization: `Bearer ${userB.jwt}` },
      payload: { contextKind: 'company', contextId: ctxB },
    })
    expect(resB.statusCode).toBe(201)
    const bId = (resB.json() as { id: string }).id
    createdSessionIds.push(bId)

    expect(aId).not.toBe(bId)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// A3 — POST /chat/sessions/:id/messages (gate paths only; Anthropic happy
//      path deferred per T23)
// ──────────────────────────────────────────────────────────────────────────

describe('POST /chat/sessions/:id/messages — A3 gates', () => {
  test('404 when session belongs to another user (no existence leak)', async () => {
    const ownerJwt = (await setupUser()).jwt
    const owner2 = await setupUser()
    const sessionId = await insertSessionDirect({ userId: owner2.userId })

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${ownerJwt}` },
      payload: { content: 'hi', lamport: String(Date.now() + 1000) },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: { code: 'CHAT_SESSION_NOT_FOUND' } })
  })

  test('404 for unknown session id', async () => {
    const { jwt } = await setupUser()
    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${TEST_PREFIX}nope/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: 'hi', lamport: String(Date.now() + 1000) },
    })
    expect(res.statusCode).toBe(404)
  })

  test('400 LAMPORT_OUT_OF_RANGE when lamport is too far in the future', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })

    const tenMinutesAhead = String(Date.now() + 10 * 60 * 1000)
    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: 'hi', lamport: tenMinutesAhead },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'LAMPORT_OUT_OF_RANGE' } })
  })

  test('400 LAMPORT_OUT_OF_RANGE when lamport is not parseable', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: 'hi', lamport: 'not-a-number' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: { code: 'LAMPORT_OUT_OF_RANGE' } })
  })

  test('409 with session+messages body when lamport is not strictly > stored', async () => {
    const { userId, jwt } = await setupUser()
    const storedLamport = String(Date.now() + 1000)
    const sessionId = await insertSessionDirect({ userId, lamport: storedLamport })

    // Equal lamport — should 409 (NOT >).
    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: 'hi', lamport: storedLamport },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { session: { id: string }; messages: unknown[] }
    expect(body.session.id).toBe(sessionId)
    expect(Array.isArray(body.messages)).toBe(true)
  })

  test('400 when content is empty', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })
    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: '', lamport: String(Date.now() + 1000) },
    })
    expect(res.statusCode).toBe(400)
  })

  test('401 when no JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${TEST_PREFIX}any/messages`,
      payload: { content: 'hi', lamport: String(Date.now() + 1000) },
    })
    expect(res.statusCode).toBe(401)
  })

  // T19 + Issue 1A — oversize content rejected with typed 413 BEFORE
  // any DB I/O or Anthropic call. CHAT_HISTORY_CHAR_BUDGET is 120k chars;
  // anything strictly greater is rejected.
  test('413 CHAT_INPUT_TOO_LARGE when content exceeds the history budget', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })

    const tooBig = 'x'.repeat(120_001) // 1 char over the budget
    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: tooBig, lamport: String(Date.now() + 1000) },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ error: { code: 'CHAT_INPUT_TOO_LARGE' } })
  })
})
