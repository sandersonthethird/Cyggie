import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'

// /auth/google/start now accepts a `redirect_target` enum ('mobile' | 'desktop').
// The desktop SyncAgent's sign-in flow uses 'desktop' so the callback handler
// 302s to DESKTOP_DEEP_LINK_BASE (cyggie-desktop://) instead of the mobile
// scheme (cyggie://).
//
// We can't drive the full callback round-trip without a real Google code, so
// this test asserts the persistence layer correctly captures redirect_target
// — that's the gateway-side correctness gate.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_DEVICE_ID = `test-desk-${Date.now().toString(36)}-XXXXXXXX`

afterAll(async () => {
  await db.delete(schema.oauthPending).where(eq(schema.oauthPending.deviceId, TEST_DEVICE_ID))
  await app.close()
})

describe('POST /auth/google/start — redirect_target', () => {
  test("defaults to redirect_target='mobile' when omitted (back-compat)", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: { 'content-type': 'application/json' },
      payload: { device_id: TEST_DEVICE_ID, device_label: 'test' },
    })
    expect(res.statusCode).toBe(200)
    const { state } = res.json() as { state: string }
    const pending = await db.query.oauthPending.findFirst({
      where: eq(schema.oauthPending.state, state),
    })
    expect(pending?.redirectTarget).toBe('mobile')
    // Cleanup this row immediately so the next test starts clean
    await db.delete(schema.oauthPending).where(eq(schema.oauthPending.state, state))
  })

  test("persists redirect_target='desktop' on the oauth_pending row", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: { 'content-type': 'application/json' },
      payload: {
        device_id: TEST_DEVICE_ID,
        device_label: 'desktop-test',
        redirect_target: 'desktop',
      },
    })
    expect(res.statusCode).toBe(200)
    const { state } = res.json() as { state: string }
    const pending = await db.query.oauthPending.findFirst({
      where: eq(schema.oauthPending.state, state),
    })
    expect(pending?.redirectTarget).toBe('desktop')
    await db.delete(schema.oauthPending).where(eq(schema.oauthPending.state, state))
  })

  test("rejects invalid redirect_target values", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/start',
      headers: { 'content-type': 'application/json' },
      payload: {
        device_id: TEST_DEVICE_ID,
        redirect_target: 'web', // not in the enum
      },
    })
    expect(res.statusCode).toBe(400)
  })
})
