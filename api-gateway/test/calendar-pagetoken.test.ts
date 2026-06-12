// Integration tests for the pageToken passthrough on GET /calendar/events.
//
// Item 1's silent-truncation fix: when a 30-day window has more events
// than `limit`, the gateway must surface Google's nextPageToken so the
// mobile client can drain the chain before advancing its day cursor.
// This file proves:
//   1. Without ?pageToken= the gateway calls events.list without one;
//      omits nextPageToken from the response when Google returns none.
//   2. With ?pageToken=<opaque> the gateway forwards it verbatim;
//      includes nextPageToken in the response when Google returns one.
//   3. Malformed pageToken (special chars) → 400 from the Zod regex,
//      preventing arbitrary strings from being proxied to googleapis.

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

// ─── Google API mock ────────────────────────────────────────────────────────
// Records every events.list call so we can assert pageToken passthrough.
// `mockedNextPageToken` controls whether the gateway sees a "more pages
// available" signal from Google.

interface MockGoogleEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}
let mockedGoogleEvents: MockGoogleEvent[] = []
let mockedNextPageToken: string | undefined = undefined
const listCalls: Array<Record<string, unknown>> = []

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(_creds: unknown): void {}
        on(_event: string, _cb: unknown): void {}
      },
    },
    calendar: () => ({
      events: {
        list: async (params: Record<string, unknown>) => {
          listCalls.push(params)
          return {
            data: {
              items: mockedGoogleEvents,
              ...(mockedNextPageToken ? { nextPageToken: mockedNextPageToken } : {}),
            },
          }
        },
      },
    }),
  },
}))

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { signAccessToken } = await import('../src/auth/jwt')
const { encryptToken } = await import('../src/auth/token-crypto')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-cal-pt-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
  await app.close()
})

beforeEach(() => {
  mockedGoogleEvents = []
  mockedNextPageToken = undefined
  listCalls.length = 0
})

async function setupUser(): Promise<{ userId: string; token: string }> {
  const userId = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id: userId,
    googleSub: 'sub-' + userId,
    email: `${userId}@example.com`,
    displayName: userId,
  })
  cleanup.track(schema.users, schema.users.id, userId)
  cleanup.track(schema.oauthTokens, schema.oauthTokens.userId, userId)
  await db.insert(schema.oauthTokens).values({
    id: TEST_PREFIX + 'oauth-' + createId().slice(0, 8),
    userId,
    provider: 'google',
    accessToken: 'fake-access-token',
    refreshTokenEncrypted: encryptToken('fake-refresh-token', env.GOOGLE_TOKEN_ENC_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    needsReauth: false,
  })
  const token = await signAccessToken(env.JWT_SIGNING_SECRET, {
    sub: userId,
    sid: TEST_PREFIX + 'session-' + userId,
    device: TEST_PREFIX + 'device',
    scope: ['user'],
    firm_id: TEST_PREFIX + 'firm',
    role: 'member',
  })
  return { userId, token }
}

describe('GET /calendar/events — pageToken passthrough (Item 1)', () => {
  test('without ?pageToken: gateway omits it from googleapis call + omits nextPageToken from response', async () => {
    const { token } = await setupUser()
    mockedGoogleEvents = []
    mockedNextPageToken = undefined

    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: unknown[]; nextPageToken?: string }
    expect(body.events).toEqual([])
    expect(body.nextPageToken).toBeUndefined()
    // Gateway must not pass pageToken when the client didn't supply one.
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]?.['pageToken']).toBeUndefined()
  })

  test('with ?pageToken: gateway forwards it AND surfaces nextPageToken when Google returns one', async () => {
    const { token } = await setupUser()
    mockedGoogleEvents = [
      {
        id: 'evt-1',
        summary: 'first',
        start: { dateTime: new Date(Date.now() + 60_000).toISOString() },
        end: { dateTime: new Date(Date.now() + 30 * 60_000).toISOString() },
      },
    ]
    mockedNextPageToken = 'next-page-XYZ'

    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events?pageToken=opaque_token-123',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: unknown[]; nextPageToken?: string }
    expect(body.events).toHaveLength(1)
    expect(body.nextPageToken).toBe('next-page-XYZ')
    expect(listCalls[0]?.['pageToken']).toBe('opaque_token-123')
  })

  test('rejects pageToken with disallowed characters (Zod regex guard)', async () => {
    const { token } = await setupUser()
    const res = await app.inject({
      method: 'GET',
      // forward-slash + space + question mark — anything beyond
      // [A-Za-z0-9_=-] must be rejected before we proxy to googleapis.
      url: '/calendar/events?pageToken=' + encodeURIComponent('bad/token here'),
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(400)
    // Gateway must NOT have called Google with a malformed token.
    expect(listCalls).toHaveLength(0)
  })

  test('omits nextPageToken from response when Google did not return one (last page)', async () => {
    const { token } = await setupUser()
    mockedGoogleEvents = []
    mockedNextPageToken = undefined

    const res = await app.inject({
      method: 'GET',
      url: '/calendar/events?pageToken=valid_token-456',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { events: unknown[]; nextPageToken?: string }
    expect(body.nextPageToken).toBeUndefined()
    // pageToken WAS forwarded — gateway doesn't second-guess the client.
    expect(listCalls[0]?.['pageToken']).toBe('valid_token-456')
  })
})
