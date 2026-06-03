// Slack user mapping integration test (External Agents V1 slice 7).
//
// Hits real Neon for slack_user_mappings + users tables. Mocks
// @slack/web-api so we don't depend on a live workspace.
//
// Covers:
//   - First call: cache miss → users.info → email-match → mapping inserted.
//   - Second call (same workspace+user): cache hit, no Slack call.
//   - Email with no matching Cyggie user: mapping inserted with NULL cyggieUserId.
//   - users.info 404: cached as 'unmapped' (stable).
//   - users.info 401 invalid_auth: bot_token_revoked, NOT cached.
//   - users.info 429 ratelimited: retries once; on 2nd failure transient (no cache).

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { and, eq, inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

// Mock the Slack Web API. usersInfoMock is set per test to control
// the response/exception shape resolveSlackUser sees.
const usersInfoMock = vi.fn()
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(() => ({
    users: { info: (args: { user: string }) => usersInfoMock(args) },
    chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1.0' }) },
  })),
}))

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { resolveSlackUser } = await import('../src/slack/user-mapping')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-mapping-${Date.now().toString(36)}-`
const TEST_WORKSPACE = `T_TEST_${createId().slice(0, 6)}`
const createdUserIds: string[] = []
const createdSlackIds: string[] = []

afterAll(async () => {
  if (createdSlackIds.length > 0) {
    await db
      .delete(schema.slackUserMappings)
      .where(
        and(
          eq(schema.slackUserMappings.slackWorkspaceId, TEST_WORKSPACE),
          inArray(schema.slackUserMappings.slackUserId, createdSlackIds),
        ),
      )
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(schema.users)
      .where(inArray(schema.users.id, createdUserIds))
  }
})

beforeEach(() => {
  usersInfoMock.mockReset()
})

async function seedUser(email: string): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email,
  })
  createdUserIds.push(id)
  return id
}

function trackSlack(slackId: string): string {
  createdSlackIds.push(slackId)
  return slackId
}

describe('resolveSlackUser — happy path', () => {
  test('first call: users.info → email match → mapping inserted', async () => {
    const email = `${TEST_PREFIX}mapped@example.com`
    const cyggieId = await seedUser(email)
    const slackId = trackSlack('U_MAP_' + createId().slice(0, 6))
    usersInfoMock.mockResolvedValueOnce({
      ok: true,
      user: { profile: { email } },
    })

    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })

    expect(result).toEqual({ kind: 'mapped', cyggieUserId: cyggieId, email })
    expect(usersInfoMock).toHaveBeenCalledTimes(1)

    // Cache row was written.
    const rows = await db
      .select()
      .from(schema.slackUserMappings)
      .where(
        and(
          eq(schema.slackUserMappings.slackWorkspaceId, TEST_WORKSPACE),
          eq(schema.slackUserMappings.slackUserId, slackId),
        ),
      )
    expect(rows).toHaveLength(1)
    expect(rows[0].cyggieUserId).toBe(cyggieId)
    expect(rows[0].slackEmail).toBe(email)
  })

  test('second call: cache hit, no Slack API call', async () => {
    const email = `${TEST_PREFIX}cached@example.com`
    const cyggieId = await seedUser(email)
    const slackId = trackSlack('U_CACHE_' + createId().slice(0, 6))
    usersInfoMock.mockResolvedValueOnce({
      ok: true,
      user: { profile: { email } },
    })

    // Prime the cache.
    await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(usersInfoMock).toHaveBeenCalledTimes(1)

    // Second call hits cache — no new users.info call.
    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result).toEqual({ kind: 'mapped', cyggieUserId: cyggieId, email })
    expect(usersInfoMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSlackUser — unmapped + 404 (stable states cached)', () => {
  test('Slack email has no matching Cyggie user → unmapped + cached', async () => {
    const slackId = trackSlack('U_NOMATCH_' + createId().slice(0, 6))
    const email = `${TEST_PREFIX}nobody@example.com` // no users row
    usersInfoMock.mockResolvedValueOnce({
      ok: true,
      user: { profile: { email } },
    })

    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result).toEqual({ kind: 'unmapped', email: email.toLowerCase() })

    // Cached so second call doesn't hit Slack.
    const result2 = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result2.kind).toBe('unmapped')
    expect(usersInfoMock).toHaveBeenCalledTimes(1)
  })

  test('users.info 404 user_not_found → unmapped + cached', async () => {
    const slackId = trackSlack('U_404_' + createId().slice(0, 6))
    usersInfoMock.mockRejectedValueOnce(
      Object.assign(new Error('user_not_found'), {
        data: { error: 'user_not_found' },
      }),
    )

    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result).toEqual({ kind: 'unmapped', email: null })

    // Cached.
    const result2 = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result2.kind).toBe('unmapped')
    expect(usersInfoMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSlackUser — failures NOT cached', () => {
  test('users.info 401 invalid_auth → bot_token_revoked, no cache row', async () => {
    const slackId = trackSlack('U_401_' + createId().slice(0, 6))
    usersInfoMock.mockRejectedValueOnce(
      Object.assign(new Error('invalid_auth'), {
        data: { error: 'invalid_auth' },
      }),
    )

    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-broken',
    })
    expect(result).toEqual({ kind: 'bot_token_revoked' })

    const rows = await db
      .select()
      .from(schema.slackUserMappings)
      .where(
        and(
          eq(schema.slackUserMappings.slackWorkspaceId, TEST_WORKSPACE),
          eq(schema.slackUserMappings.slackUserId, slackId),
        ),
      )
    expect(rows).toHaveLength(0)
  })

  test('users.info 429 retried once; second failure → transient_failure, no cache', async () => {
    const slackId = trackSlack('U_429_' + createId().slice(0, 6))
    usersInfoMock
      .mockRejectedValueOnce(
        Object.assign(new Error('ratelimited'), {
          data: { error: 'ratelimited' },
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('ratelimited'), {
          data: { error: 'ratelimited' },
        }),
      )

    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result).toEqual({ kind: 'transient_failure' })
    expect(usersInfoMock).toHaveBeenCalledTimes(2)

    const rows = await db
      .select()
      .from(schema.slackUserMappings)
      .where(
        and(
          eq(schema.slackUserMappings.slackWorkspaceId, TEST_WORKSPACE),
          eq(schema.slackUserMappings.slackUserId, slackId),
        ),
      )
    expect(rows).toHaveLength(0)
  })

  test('users.info 429 once, then success → mapped (retry recovers)', async () => {
    const email = `${TEST_PREFIX}retry@example.com`
    const cyggieId = await seedUser(email)
    const slackId = trackSlack('U_RETRY_' + createId().slice(0, 6))
    usersInfoMock
      .mockRejectedValueOnce(
        Object.assign(new Error('ratelimited'), {
          data: { error: 'ratelimited' },
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        user: { profile: { email } },
      })

    const result = await resolveSlackUser({
      db,
      workspaceId: TEST_WORKSPACE,
      slackUserId: slackId,
      slackBotToken: 'xoxb-test',
    })
    expect(result).toEqual({ kind: 'mapped', cyggieUserId: cyggieId, email })
    expect(usersInfoMock).toHaveBeenCalledTimes(2)
  })
})
