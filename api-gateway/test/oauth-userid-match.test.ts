import { afterAll, describe, expect, test, vi } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { inArray } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Defense-in-depth: when the "Reconnect Google" flow is initiated by a
// signed-in client (Bearer at /start → oauth_pending.user_id set), the callback
// must reject if the resolved Google identity maps to a DIFFERENT user — so
// re-consenting with another Google account can't silently swap identity.
//
// Mock the Google client so the callback resolves a controlled identity without
// hitting Google. Must be mocked BEFORE buildApp imports it. fetchGoogleIdentity
// returns whatever `identityMock` yields; exchangeCodeForTokens returns a minimal
// token set with refreshToken=null (skips the GOOGLE_TOKEN_ENC_KEY path).
const identityMock = vi.fn()
vi.mock('../src/auth/google', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/google')>()
  return {
    ...actual,
    exchangeCodeForTokens: vi.fn(async () => ({
      accessToken: 'access-x',
      refreshToken: null,
      idToken: 'id-x',
      expiryDate: new Date(Date.now() + 3600_000),
      scope: 'openid email',
    })),
    fetchGoogleIdentity: vi.fn(async () => identityMock()),
  }
})

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { rememberPending } = await import('../src/auth/pending')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const P = `test-uidm-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)
const userIds: string[] = []

async function seedUser(googleSub: string): Promise<string> {
  const id = P + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub,
    email: `${id}@example.com`,
    displayName: id,
  })
  cleanup.track(schema.users, schema.users.id, id)
  userIds.push(id)
  return id
}

async function remember(state: string, userId: string | null): Promise<void> {
  await rememberPending({
    databaseUrl: env.GATEWAY_DATABASE_URL,
    state,
    codeVerifier: 'verifier-x',
    deviceId: P + 'device',
    deviceLabel: null,
    userId,
  })
}

function callback(state: string) {
  return app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=code-x&state=${encodeURIComponent(state)}`,
  })
}

afterAll(async () => {
  // Success cases (match / null) mint a session + oauth_tokens + audit row for
  // the resolved user. Clear them before deleting the users (belt-and-suspenders
  // over FK cascade).
  if (userIds.length) {
    await db.delete(schema.sessions).where(inArray(schema.sessions.userId, userIds))
    await db.delete(schema.oauthTokens).where(inArray(schema.oauthTokens.userId, userIds))
    await db.delete(schema.auditLog).where(inArray(schema.auditLog.userId, userIds))
  }
  await cleanup.cleanup()
  await app.close()
})

describe('GET /auth/google/callback — userId-match defense', () => {
  test('mismatch: Bearer=userA at /start but Google resolves userB → 400 OAUTH_USERID_MISMATCH', async () => {
    const subA = P + 'subA'
    const subB = P + 'subB'
    const userA = await seedUser(subA)
    await seedUser(subB) // userB exists, keyed by subB
    const state = P + 'mismatch'
    await remember(state, userA) // initiated by userA
    identityMock.mockReturnValueOnce({
      googleSub: subB, // …but Google came back as userB
      email: `${P}b@example.com`,
      emailVerified: true,
      name: undefined,
      picture: undefined,
    })

    const res = await callback(state)
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('OAUTH_USERID_MISMATCH')
  })

  test('match: Bearer=userA and Google resolves userA → succeeds (302 redirect, no mismatch)', async () => {
    const subA = P + 'subMatch'
    const userA = await seedUser(subA)
    const state = P + 'match'
    await remember(state, userA)
    identityMock.mockReturnValueOnce({
      googleSub: subA,
      email: `${P}match@example.com`,
      emailVerified: true,
      name: undefined,
      picture: undefined,
    })

    const res = await callback(state)
    expect(res.statusCode).toBe(302) // redirect to deep link; not a 400
  })

  test('no Bearer at /start (pending.user_id NULL) → fresh sign-in succeeds (back-compat)', async () => {
    const subC = P + 'subNull'
    await seedUser(subC)
    const state = P + 'null'
    await remember(state, null) // public sign-in, no initiating user
    identityMock.mockReturnValueOnce({
      googleSub: subC,
      email: `${P}null@example.com`,
      emailVerified: true,
      name: undefined,
      picture: undefined,
    })

    const res = await callback(state)
    expect(res.statusCode).toBe(302) // no check performed
  })
})
