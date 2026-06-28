import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createId } from '@paralleldrive/cuid2'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Slice A — the Anthropic env-key fallback is firm-gated so firm #2 can never
// bill Red Swan's shared key. These exercise the 4 branches of the gate against
// a real test DB (resolveProviderKeyFromDb hits user_credentials):
//
//   1. user_credentials row present → returns it, regardless of firm
//   2. no row + firmId === BETA_FIRM_ID → env key
//   3. no row + firmId !== BETA_FIRM_ID → null
//   4. no row + firmId === null      → null
//   (+ fail-safe: BETA_FIRM_ID unset → null even for a matching-looking firm)
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { resolveAnthropicKey } = await import('../src/llm/resolve-key')

const baseEnv = loadEnv()
const db = getDb(baseEnv.GATEWAY_DATABASE_URL)
const cleanup = makeDbCleanup(db)
const PREFIX = `test-rak-${Date.now().toString(36)}-`

const BETA_FIRM = PREFIX + 'firm-beta'
const OTHER_FIRM = PREFIX + 'firm-other'
const ENV_KEY = 'sk-env-shared-key'

// env with the beta gate configured (firmId is passed as an arg, so no firms row needed)
const gatedEnv = { ...baseEnv, BETA_FIRM_ID: BETA_FIRM, ANTHROPIC_API_KEY: ENV_KEY }

// A user WITH an anthropic credential row, and one WITHOUT.
const USER_WITH_KEY = PREFIX + 'u-haskey'
const USER_NO_KEY = PREFIX + 'u-nokey'

async function mkUser(id: string): Promise<void> {
  await db
    .insert(schema.users)
    .values({ id, googleSub: 'sub-' + id, email: `${id}@example.com`, displayName: id })
  cleanup.track(schema.users, schema.users.id, id)
}

beforeAll(async () => {
  await mkUser(USER_WITH_KEY)
  await mkUser(USER_NO_KEY)
  await db
    .insert(schema.userCredentials)
    .values({ userId: USER_WITH_KEY, provider: 'anthropic', value: 'sk-user-own-key' })
  cleanup.track(schema.userCredentials, schema.userCredentials.userId, USER_WITH_KEY)
})

afterAll(() => cleanup.cleanup())

describe('resolveAnthropicKey firm-gate', () => {
  test('1. user_credentials row wins, regardless of firm', async () => {
    // even a non-beta firm with no env match → the user's own row is used
    expect(await resolveAnthropicKey(gatedEnv, USER_WITH_KEY, OTHER_FIRM)).toBe('sk-user-own-key')
    expect(await resolveAnthropicKey(gatedEnv, USER_WITH_KEY, null)).toBe('sk-user-own-key')
  })

  test('2. no row + firmId === BETA_FIRM_ID → shared env key', async () => {
    expect(await resolveAnthropicKey(gatedEnv, USER_NO_KEY, BETA_FIRM)).toBe(ENV_KEY)
  })

  test('3. no row + firmId !== BETA_FIRM_ID → null (no shared key for firm #2)', async () => {
    expect(await resolveAnthropicKey(gatedEnv, USER_NO_KEY, OTHER_FIRM)).toBeNull()
  })

  test('4. no row + firmId === null → null', async () => {
    expect(await resolveAnthropicKey(gatedEnv, USER_NO_KEY, null)).toBeNull()
  })

  test('fail-safe: BETA_FIRM_ID unset → null even when env key exists', async () => {
    const ungatedEnv = { ...baseEnv, BETA_FIRM_ID: undefined, ANTHROPIC_API_KEY: ENV_KEY }
    expect(await resolveAnthropicKey(ungatedEnv, USER_NO_KEY, BETA_FIRM)).toBeNull()
  })
})
