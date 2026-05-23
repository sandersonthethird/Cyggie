import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Defensive regression — the legacy POST /chat/messages stateless route
// was removed 2026-05-23 (T18+T19 plan, Issue 2A). This test fails if
// someone accidentally re-registers it. Fastify returns 404 for unknown
// routes by default; we assert that.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { buildApp } = await import('../src/app')
const { loadEnv } = await import('../src/env')

const env = loadEnv()
const app = await buildApp(env)
await app.ready()

afterAll(async () => {
  await app.close()
})

describe('POST /chat/messages (deleted)', () => {
  test('returns 404 — route was removed 2026-05-23', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/chat/messages',
      payload: { message: 'hi' },
    })
    expect(res.statusCode).toBe(404)
  })
})
