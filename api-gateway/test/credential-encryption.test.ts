import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { schema } from '@cyggie/db'
import { makeDbCleanup } from './_helpers/db-cleanup'

// Slice C — at-rest encryption of user_credentials, exercised through the real
// resolver (resolveAnthropicKey → resolveProviderKeyFromDb → decryptStoredCredential):
//   • encrypted row              → decrypted value returned
//   • legacy plaintext row       → returned verbatim (Red Swan, transitional)
//   • tampered encrypted row     → throws CREDENTIAL_UNREADABLE (never upstream)
loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env.local') })
process.env['NODE_ENV'] = 'test'

const { loadEnv } = await import('../src/env')
const { getDb } = await import('../src/db')
const { resolveAnthropicKey } = await import('../src/llm/resolve-key')
const { encryptToken } = await import('../src/auth/token-crypto')

const baseEnv = loadEnv()
const db = getDb(baseEnv.GATEWAY_DATABASE_URL)
const cleanup = makeDbCleanup(db)
const PREFIX = `test-credenc-${Date.now().toString(36)}-`

// A known test key; firmId is irrelevant here (the user always has a row, so the
// firm-gate returns it before any env fallback).
const ENC_KEY = randomBytes(32).toString('base64')
const env = { ...baseEnv, CREDENTIAL_ENC_KEY: ENC_KEY }
const ANY_FIRM = PREFIX + 'firm'

const U_ENC = PREFIX + 'u-enc'
const U_LEGACY = PREFIX + 'u-legacy'
const U_TAMPER = PREFIX + 'u-tamper'

async function mkUser(id: string): Promise<void> {
  await db
    .insert(schema.users)
    .values({ id, googleSub: 'sub-' + id, email: `${id}@example.com`, displayName: id })
  cleanup.track(schema.users, schema.users.id, id)
}

async function putCred(userId: string, value: string): Promise<void> {
  await db.insert(schema.userCredentials).values({ userId, provider: 'anthropic', value })
  cleanup.track(schema.userCredentials, schema.userCredentials.userId, userId)
}

beforeAll(async () => {
  await mkUser(U_ENC)
  await mkUser(U_LEGACY)
  await mkUser(U_TAMPER)

  await putCred(U_ENC, encryptToken('sk-real-key', ENC_KEY, 'CREDENTIAL_ENC_KEY'))
  await putCred(U_LEGACY, 'sk-plaintext-legacy') // pre-encryption row (no colons)

  // A genuinely-encrypted blob with one ciphertext byte flipped → GCM auth fails.
  const blob = encryptToken('sk-tampered', ENC_KEY, 'CREDENTIAL_ENC_KEY')
  const [iv, tag, ct] = blob.split(':')
  const ctBuf = Buffer.from(ct, 'base64url')
  ctBuf[0] ^= 0xff
  await putCred(U_TAMPER, [iv, tag, ctBuf.toString('base64url')].join(':'))
})

afterAll(() => cleanup.cleanup())

describe('user_credentials at-rest encryption (Slice C)', () => {
  test('encrypted row decrypts to the original key', async () => {
    expect(await resolveAnthropicKey(env, U_ENC, ANY_FIRM)).toBe('sk-real-key')
  })

  test('legacy plaintext row is returned verbatim (transitional tolerance)', async () => {
    expect(await resolveAnthropicKey(env, U_LEGACY, ANY_FIRM)).toBe('sk-plaintext-legacy')
  })

  test('tampered ciphertext throws CREDENTIAL_UNREADABLE, never returns garbage', async () => {
    await expect(resolveAnthropicKey(env, U_TAMPER, ANY_FIRM)).rejects.toMatchObject({
      code: 'CREDENTIAL_UNREADABLE',
      statusCode: 503,
    })
  })
})
