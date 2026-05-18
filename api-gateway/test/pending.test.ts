import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inArray, sql } from 'drizzle-orm'
import { schema } from '@cyggie/db'

loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local'),
})
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const {
  consumePending,
  generatePkcePair,
  generateState,
  rememberPending,
} = await import('../src/auth/pending')

const env = loadEnv()
const db = getDb(env.GATEWAY_DATABASE_URL)
const createdStates: string[] = []

afterAll(async () => {
  if (createdStates.length > 0) {
    await db.delete(schema.oauthPending).where(inArray(schema.oauthPending.state, createdStates))
  }
})

describe('oauth_pending (Postgres-backed)', () => {
  test('rememberPending stores a row keyed by state', async () => {
    const state = generateState()
    createdStates.push(state)
    const { codeVerifier } = generatePkcePair()
    await rememberPending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
      codeVerifier,
      deviceId: 'test-device-1',
      deviceLabel: 'Test iPhone',
    })
    const rows = await db
      .select()
      .from(schema.oauthPending)
      .where(sql`${schema.oauthPending.state} = ${state}`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.codeVerifier).toBe(codeVerifier)
    expect(rows[0]?.deviceId).toBe('test-device-1')
    expect(rows[0]?.deviceLabel).toBe('Test iPhone')
  })

  test('consumePending returns the row and deletes it in one shot', async () => {
    const state = generateState()
    createdStates.push(state)
    const { codeVerifier } = generatePkcePair()
    await rememberPending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
      codeVerifier,
      deviceId: 'test-device-2',
      deviceLabel: null,
    })
    const result = await consumePending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
    })
    expect(result).not.toBeNull()
    expect(result?.codeVerifier).toBe(codeVerifier)
    expect(result?.deviceId).toBe('test-device-2')
    // Row is gone.
    const rows = await db
      .select()
      .from(schema.oauthPending)
      .where(sql`${schema.oauthPending.state} = ${state}`)
    expect(rows).toHaveLength(0)
  })

  test('consumePending returns null for an unknown state', async () => {
    const result = await consumePending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state: 'never-existed-' + Date.now(),
    })
    expect(result).toBeNull()
  })

  test('consumePending returns null after the row is expired', async () => {
    const state = generateState()
    createdStates.push(state)
    // Insert directly with an already-passed expires_at.
    await db.insert(schema.oauthPending).values({
      state,
      codeVerifier: 'expired-verifier',
      deviceId: 'test-device-expired',
      deviceLabel: null,
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    })
    const result = await consumePending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
    })
    expect(result).toBeNull()
    // Row was deleted as part of consumePending (atomic DELETE RETURNING).
    const rows = await db
      .select()
      .from(schema.oauthPending)
      .where(sql`${schema.oauthPending.state} = ${state}`)
    expect(rows).toHaveLength(0)
  })

  test('second consumePending for the same state returns null (single-use)', async () => {
    const state = generateState()
    createdStates.push(state)
    await rememberPending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
      codeVerifier: 'one-shot',
      deviceId: 'test-device-replay',
      deviceLabel: null,
    })
    const first = await consumePending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
    })
    expect(first).not.toBeNull()
    const second = await consumePending({
      databaseUrl: env.GATEWAY_DATABASE_URL,
      state,
    })
    expect(second).toBeNull()
  })
})
