// Slack thread continuity integration test (External Agents V1 slice 6).
//
// Hits real Neon for chat_sessions + chat_session_messages. Verifies
// the find-or-create + load + append cycle for both threaded and DM
// flows, plus the COALESCE-based unique index that collapses DM NULLs
// per channel.

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const {
  findOrCreateSlackSession,
  loadSlackSessionMessages,
  appendSlackTurn,
} = await import('../src/slack/thread-session')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-thread-${Date.now().toString(36)}-`
const TEST_WORKSPACE = `T_THR_${createId().slice(0, 6)}`
const cleanup = makeDbCleanup(db)

// Track a session plus its messages. Tracking the session row first then its
// messages-by-sessionId means cleanup (reverse order) deletes messages before
// the session — FK-safe, mirroring the old explicit two-step delete.
function trackSession(sessionId: string): void {
  cleanup.track(schema.chatSessions, schema.chatSessions.id, sessionId)
  cleanup.track(schema.chatSessionMessages, schema.chatSessionMessages.sessionId, sessionId)
}

afterAll(() => cleanup.cleanup())

async function seedUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

describe('findOrCreateSlackSession — threaded flow', () => {
  test('first call creates row marked isNew=true', async () => {
    const userId = await seedUser()
    const channel = 'C_THREAD_' + createId().slice(0, 6)
    const threadTs = '1700000000.000100'

    const session = await findOrCreateSlackSession({
      db,
      userId,
      key: { workspaceId: TEST_WORKSPACE, channelId: channel, threadTs },
    })
    trackSession(session.id)
    expect(session.isNew).toBe(true)
    expect(session.userId).toBe(userId)

    // Row has origin='slack' + all three slack columns set.
    const rows = await db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, session.id))
    expect(rows[0]).toMatchObject({
      origin: 'slack',
      slackWorkspaceId: TEST_WORKSPACE,
      slackChannelId: channel,
      slackThreadTs: threadTs,
    })
  })

  test('second call same thread returns existing session, isNew=false', async () => {
    const userId = await seedUser()
    const channel = 'C_SAME_' + createId().slice(0, 6)
    const threadTs = '1700000001.000100'
    const key = { workspaceId: TEST_WORKSPACE, channelId: channel, threadTs }

    const first = await findOrCreateSlackSession({ db, userId, key })
    trackSession(first.id)
    expect(first.isNew).toBe(true)

    const second = await findOrCreateSlackSession({ db, userId, key })
    expect(second.id).toBe(first.id)
    expect(second.isNew).toBe(false)
  })
})

describe('findOrCreateSlackSession — DM flow (null thread_ts)', () => {
  test('multiple DM calls in same channel share one session', async () => {
    const userId = await seedUser()
    const channel = 'D_DM_' + createId().slice(0, 6)
    const key = { workspaceId: TEST_WORKSPACE, channelId: channel, threadTs: null }

    const first = await findOrCreateSlackSession({ db, userId, key })
    trackSession(first.id)
    expect(first.isNew).toBe(true)

    const second = await findOrCreateSlackSession({ db, userId, key })
    expect(second.id).toBe(first.id)
    expect(second.isNew).toBe(false)

    // DB row has slackThreadTs = NULL.
    const rows = await db
      .select({ slackThreadTs: schema.chatSessions.slackThreadTs })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, first.id))
    expect(rows[0].slackThreadTs).toBeNull()
  })

  test('different channels (same workspace, both DM) get distinct sessions', async () => {
    const userId = await seedUser()
    const ch1 = 'D_A_' + createId().slice(0, 6)
    const ch2 = 'D_B_' + createId().slice(0, 6)
    const a = await findOrCreateSlackSession({
      db,
      userId,
      key: { workspaceId: TEST_WORKSPACE, channelId: ch1, threadTs: null },
    })
    const b = await findOrCreateSlackSession({
      db,
      userId,
      key: { workspaceId: TEST_WORKSPACE, channelId: ch2, threadTs: null },
    })
    trackSession(a.id)
    trackSession(b.id)
    expect(a.id).not.toBe(b.id)
  })
})

describe('loadSlackSessionMessages + appendSlackTurn', () => {
  test('empty session loads no messages', async () => {
    const userId = await seedUser()
    const session = await findOrCreateSlackSession({
      db,
      userId,
      key: {
        workspaceId: TEST_WORKSPACE,
        channelId: 'C_EMPTY_' + createId().slice(0, 6),
        threadTs: '1700000010.000100',
      },
    })
    trackSession(session.id)
    const msgs = await loadSlackSessionMessages({ db, sessionId: session.id })
    expect(msgs).toEqual([])
  })

  test('appendSlackTurn persists user+assistant pair atomically; load returns chronological order', async () => {
    const userId = await seedUser()
    const session = await findOrCreateSlackSession({
      db,
      userId,
      key: {
        workspaceId: TEST_WORKSPACE,
        channelId: 'C_TURN_' + createId().slice(0, 6),
        threadTs: '1700000020.000100',
      },
    })
    trackSession(session.id)

    await appendSlackTurn({
      db,
      sessionId: session.id,
      userText: 'how much did Acme raise?',
      assistantText: 'Acme raised $12.5M Series A.',
    })
    await appendSlackTurn({
      db,
      sessionId: session.id,
      userText: 'what about their CEO?',
      assistantText: 'Jane Doe is the CEO.',
    })

    const msgs = await loadSlackSessionMessages({ db, sessionId: session.id })
    expect(msgs.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'how much did Acme raise?' },
      { role: 'assistant', content: 'Acme raised $12.5M Series A.' },
      { role: 'user', content: 'what about their CEO?' },
      { role: 'assistant', content: 'Jane Doe is the CEO.' },
    ])

    // Session row counters updated atomically.
    const [sessionRow] = await db
      .select({
        messageCount: schema.chatSessions.messageCount,
        previewText: schema.chatSessions.previewText,
      })
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, session.id))
    expect(sessionRow.messageCount).toBe(4)
    expect(sessionRow.previewText).toBe('Jane Doe is the CEO.')
  })
})
