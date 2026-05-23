import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// T18 — POST /chat/sessions/:id/messages SSE streaming branch.
//
// Opt-in via `Accept: text/event-stream` header. Without it, blocking path
// runs (tested in chat-sessions-a3-a4.test.ts). With it, the gateway:
//   1. Writes SSE headers + flushes
//   2. Iterates client.messages.stream() emitting `event: token` per delta
//   3. Persists user + assistant messages in a transaction
//   4. Emits `event: done` with the final {session, userMessage, assistantMessage}
//   5. On abort: ends silently, no DB writes
//   6. On Anthropic error: emits `event: error`, no DB writes
//   7. On zero tokens: emits `event: done` with empty assistant content
//
// Anthropic SDK is mocked at the module level — see vi.mock factory below.
// The mock is controllable per-test via the `__mockState` global so we can
// inject deltas / errors / abort signals without spinning up a real client.

interface MockState {
  deltas: string[]
  error?: Error
  abort?: boolean
}

declare global {
  // eslint-disable-next-line no-var
  var __anthropicMockState: MockState
}

globalThis.__anthropicMockState = { deltas: [] }

vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number
    constructor(msg: string = 'api error', status?: number) {
      super(msg)
      this.name = 'APIError'
      if (status !== undefined) this.status = status
    }
  }
  class APIUserAbortError extends APIError {
    constructor(msg: string = 'aborted') {
      super(msg)
      this.name = 'APIUserAbortError'
    }
  }
  class FakeStream {
    constructor(private state: MockState) {}
    async *[Symbol.asyncIterator]() {
      for (const text of this.state.deltas) {
        if (this.state.abort) throw new APIUserAbortError()
        if (this.state.error) throw this.state.error
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }
      }
      if (this.state.abort) throw new APIUserAbortError()
      if (this.state.error) throw this.state.error
    }
    async finalMessage() {
      return {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: this.state.deltas.join('') }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: this.state.deltas.length },
      }
    }
  }
  class Anthropic {
    messages = {
      stream: (_params: unknown, _opts?: unknown): FakeStream => {
        return new FakeStream(globalThis.__anthropicMockState)
      },
      create: async (_params: unknown, _opts?: unknown) => ({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [
          { type: 'text', text: globalThis.__anthropicMockState.deltas.join('') },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    }
    constructor(_opts: { apiKey: string }) {
      // No-op
    }
  }
  return {
    default: Object.assign(Anthropic, { APIError, APIUserAbortError }),
    APIError,
    APIUserAbortError,
  }
})

// resolveAnthropicKey reads env or user_credentials. Mock it to always
// return a key so the handler proceeds past the 503 gate.
vi.mock('../src/llm/resolve-key', async () => {
  const actual = await vi.importActual<typeof import('../src/llm/resolve-key')>(
    '../src/llm/resolve-key',
  )
  return {
    ...actual,
    resolveAnthropicKey: async () => 'sk-mock-test-key',
  }
})

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

const TEST_PREFIX = `test-chat-stream-${Date.now().toString(36)}-`
const createdUserIds: string[] = []
const createdSessionIds: string[] = []

afterAll(async () => {
  if (createdSessionIds.length > 0) {
    await db.delete(schema.chatSessions).where(inArray(schema.chatSessions.id, createdSessionIds))
  }
  if (createdUserIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds))
  }
  await app.close()
})

beforeEach(() => {
  globalThis.__anthropicMockState = { deltas: [] }
})

afterEach(() => {
  globalThis.__anthropicMockState = { deltas: [] }
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

async function insertSessionDirect(opts: { userId: string }): Promise<string> {
  const id = TEST_PREFIX + 'sess-' + createId().slice(0, 8)
  await db.insert(schema.chatSessions).values({
    id,
    userId: opts.userId,
    contextId: id,
    contextKind: 'crm',
    contextLabel: null,
    title: null,
    lamport: '1',
    lastMessageAt: new Date(),
    createdByUserId: opts.userId,
  })
  createdSessionIds.push(id)
  return id
}

function parseSseEvents(body: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = []
  const blocks = body.split('\n\n').filter((b) => b.trim())
  for (const block of blocks) {
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '))
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
    if (!eventLine || !dataLine) continue
    const event = eventLine.slice('event: '.length).trim()
    try {
      const data = JSON.parse(dataLine.slice('data: '.length))
      out.push({ event, data })
    } catch {
      out.push({ event, data: dataLine.slice('data: '.length) })
    }
  }
  return out
}

describe('POST /chat/sessions/:id/messages — T18 SSE streaming', () => {
  test('1. with Accept: text/event-stream → streams tokens + final done', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })
    globalThis.__anthropicMockState = { deltas: ['Hello', ' ', 'world'] }

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'text/event-stream',
      },
      payload: { content: 'hi', lamport: String(Date.now() + 1000) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.headers['cache-control']).toContain('no-cache')
    expect(res.headers['x-accel-buffering']).toBe('no')

    const events = parseSseEvents(res.body)
    const tokenEvents = events.filter((e) => e.event === 'token')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(tokenEvents.map((e) => (e.data as { text: string }).text)).toEqual([
      'Hello',
      ' ',
      'world',
    ])
    expect(doneEvents).toHaveLength(1)
    const doneData = doneEvents[0]!.data as {
      session: { id: string }
      userMessage: { content: string }
      assistantMessage: { content: string }
    }
    expect(doneData.session.id).toBe(sessionId)
    expect(doneData.userMessage.content).toBe('hi')
    expect(doneData.assistantMessage.content).toBe('Hello world')

    // Persisted in DB?
    const persistedRows = await db
      .select()
      .from(schema.chatSessionMessages)
      .where(eq(schema.chatSessionMessages.sessionId, sessionId))
    expect(persistedRows).toHaveLength(2)
    expect(persistedRows.map((r) => r.role).sort()).toEqual(['assistant', 'user'])
  })

  test('2. without Accept header → blocking JSON path (unchanged contract)', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })
    globalThis.__anthropicMockState = { deltas: ['Hi there.'] }

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { content: 'ping', lamport: String(Date.now() + 1000) },
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    const body = res.json() as {
      session: { id: string }
      userMessage: { content: string }
      assistantMessage: { content: string }
    }
    expect(body.session.id).toBe(sessionId)
    expect(body.userMessage.content).toBe('ping')
    expect(body.assistantMessage.content).toBe('Hi there.')
  })

  test('3. client abort mid-stream → no DB writes, no done event', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })
    globalThis.__anthropicMockState = {
      deltas: ['partial'],
      abort: true,
    }

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'text/event-stream',
      },
      payload: { content: 'abandon me', lamport: String(Date.now() + 1000) },
    })

    expect(res.statusCode).toBe(200)
    const events = parseSseEvents(res.body)
    expect(events.find((e) => e.event === 'done')).toBeUndefined()
    expect(events.find((e) => e.event === 'error')).toBeUndefined()

    // No DB writes — outbox-like assertion via direct table check.
    const persistedRows = await db
      .select()
      .from(schema.chatSessionMessages)
      .where(eq(schema.chatSessionMessages.sessionId, sessionId))
    expect(persistedRows).toHaveLength(0)
  })

  test('4. Anthropic error mid-stream → event: error, no DB writes', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })
    globalThis.__anthropicMockState = {
      deltas: ['partial'],
      error: new Error('upstream 502'),
    }

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'text/event-stream',
      },
      payload: { content: 'doomed', lamport: String(Date.now() + 1000) },
    })

    expect(res.statusCode).toBe(200)
    const events = parseSseEvents(res.body)
    const errorEvent = events.find((e) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent!.data as { code: string }).code).toBe('CHAT_STREAM_ERROR')
    expect(events.find((e) => e.event === 'done')).toBeUndefined()

    const persistedRows = await db
      .select()
      .from(schema.chatSessionMessages)
      .where(eq(schema.chatSessionMessages.sessionId, sessionId))
    expect(persistedRows).toHaveLength(0)
  })

  test('5. zero-token stream → event: done with empty assistant message', async () => {
    const { userId, jwt } = await setupUser()
    const sessionId = await insertSessionDirect({ userId })
    globalThis.__anthropicMockState = { deltas: [] }

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'text/event-stream',
      },
      payload: { content: 'silent treatment', lamport: String(Date.now() + 1000) },
    })

    expect(res.statusCode).toBe(200)
    const events = parseSseEvents(res.body)
    const tokenEvents = events.filter((e) => e.event === 'token')
    const doneEvents = events.filter((e) => e.event === 'done')

    expect(tokenEvents).toHaveLength(0)
    expect(doneEvents).toHaveLength(1)
    const doneData = doneEvents[0]!.data as { assistantMessage: { content: string } }
    expect(doneData.assistantMessage.content).toBe('')

    // Empty assistant message IS persisted (parity with blocking path).
    const persistedRows = await db
      .select()
      .from(schema.chatSessionMessages)
      .where(eq(schema.chatSessionMessages.sessionId, sessionId))
    expect(persistedRows).toHaveLength(2)
    const assistantRow = persistedRows.find((r) => r.role === 'assistant')
    expect(assistantRow?.content).toBe('')
  })

  test('6. 409 lamport conflict still returns plain HTTP 409 (no SSE)', async () => {
    const { userId, jwt } = await setupUser()
    const storedLamport = String(Date.now() + 1000)
    const sessionId = await insertSessionDirect({ userId })
    // Bump session lamport so the incoming = storedLamport triggers 409.
    await db
      .update(schema.chatSessions)
      .set({ lamport: storedLamport })
      .where(eq(schema.chatSessions.id, sessionId))

    const res = await app.inject({
      method: 'POST',
      url: `/chat/sessions/${sessionId}/messages`,
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'text/event-stream',
      },
      payload: { content: 'race', lamport: storedLamport },
    })

    expect(res.statusCode).toBe(409)
    // Should NOT be SSE — pre-stream rejection.
    expect(res.headers['content-type']).not.toContain('text/event-stream')
  })
})
