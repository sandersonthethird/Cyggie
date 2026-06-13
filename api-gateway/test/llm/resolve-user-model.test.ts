import { afterAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from '../_helpers/db-cleanup'

// resolveUserModel against the ephemeral test Postgres. Verifies the
// user_preferences hit path and the fallback when no row exists.

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})

process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../../src/env')
const { getDb } = await import('../../src/db')
const { resolveUserModel } = await import('../../src/llm/resolve-user-model')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)

const TEST_PREFIX = `test-rum-${Date.now().toString(36)}-`
const cleanup = makeDbCleanup(db)

afterAll(async () => {
  await cleanup.cleanup()
})

async function insertTestUser(): Promise<string> {
  const id = TEST_PREFIX + createId().slice(0, 8)
  await db.insert(schema.users).values({
    id,
    googleSub: 'sub-' + id,
    email: `${id}@example.com`,
    displayName: id,
  })
  cleanup.track(schema.users, schema.users.id, id)
  return id
}

describe('resolveUserModel', () => {
  test('returns the stored preference value when a row exists', async () => {
    const userId = await insertTestUser()
    await db.insert(schema.userPreferences).values({
      userId,
      key: 'chatModel',
      value: 'claude-opus-4-6',
    })
    cleanup.track(schema.userPreferences, schema.userPreferences.userId, userId)

    const model = await resolveUserModel(env, userId, 'chatModel', 'fallback-model')
    expect(model).toBe('claude-opus-4-6')
  })

  test('falls back when no preference row exists', async () => {
    const userId = await insertTestUser()
    const model = await resolveUserModel(env, userId, 'chatModel', 'fallback-model')
    expect(model).toBe('fallback-model')
  })

  test('falls back when the stored value is blank', async () => {
    const userId = await insertTestUser()
    await db.insert(schema.userPreferences).values({
      userId,
      key: 'enhancementModel',
      value: '   ',
    })
    cleanup.track(schema.userPreferences, schema.userPreferences.userId, userId)

    const model = await resolveUserModel(env, userId, 'enhancementModel', 'fallback-model')
    expect(model).toBe('fallback-model')
  })
})
