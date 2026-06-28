/**
 * reencrypt-user-credentials.ts — Slice C rollout step (multi-firm onboarding).
 *
 * Brings every firm's stored provider keys to encryption parity. After Slice C
 * ships, the PUT route encrypts new keys (AES-256-GCM, env.CREDENTIAL_ENC_KEY)
 * and the resolver decrypts on read while TOLERATING pre-encryption plaintext
 * rows (Red Swan's existing keys) so the rollout is zero-downtime.
 *
 * This standalone ops script closes that gap: it walks user_credentials and
 * re-writes any legacy plaintext value as ciphertext. Idempotent — already
 * encrypted rows (iv:authTag:ciphertext, 3 colon-delimited base64url parts that
 * decrypt cleanly) are skipped. Run it AFTER deploying Slice C, then verify zero
 * plaintext rows remain; only then is it safe to drop the resolver's legacy
 * tolerance (TODOS.md MF-2).
 *
 * Reuses the gateway's own primitives — no parallel crypto, no in-app launch-time
 * logic. NOTE: with the per-(user,provider) PK and `value` being the only secret
 * column, re-encrypting is a plain UPDATE of `value`.
 *
 * Usage:
 *   npx tsx scripts/reencrypt-user-credentials.ts            # apply
 *   npx tsx scripts/reencrypt-user-credentials.ts --dry-run  # report only
 *
 * Env (from ../.env.local or the shell):
 *   GATEWAY_DATABASE_URL   — Neon connection (same role the gateway uses)
 *   CREDENTIAL_ENC_KEY     — base64 of 32 bytes; MUST match the gateway's key
 */
import { config as loadDotenv } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { and, eq } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb, closeDb } from '../api-gateway/src/db'
import {
  encryptToken,
  decryptToken,
  TokenCryptoError,
} from '../api-gateway/src/auth/token-crypto'

loadDotenv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env.local') })

const dryRun = process.argv.includes('--dry-run')
const dbUrl = process.env['GATEWAY_DATABASE_URL']
const encKey = process.env['CREDENTIAL_ENC_KEY']

if (!dbUrl) throw new Error('GATEWAY_DATABASE_URL is required')
if (!encKey) throw new Error('CREDENTIAL_ENC_KEY is required (must match the gateway)')

/** Already-encrypted iff it round-trips through decrypt with the configured key. */
function isAlreadyEncrypted(value: string): boolean {
  try {
    decryptToken(value, encKey!, 'CREDENTIAL_ENC_KEY')
    return true
  } catch (err) {
    if (err instanceof TokenCryptoError && err.kind === 'legacy') return false
    // decrypt_failed / bad_key: NOT plaintext, but we can't read it either —
    // surface loudly rather than double-encrypt or skip silently.
    throw err
  }
}

async function main(): Promise<void> {
  const db = getDb(dbUrl!)
  const rows = await db
    .select({
      userId: schema.userCredentials.userId,
      provider: schema.userCredentials.provider,
      value: schema.userCredentials.value,
    })
    .from(schema.userCredentials)

  let encrypted = 0
  let skipped = 0
  const failures: { userId: string; provider: string; reason: string }[] = []

  for (const row of rows) {
    try {
      if (isAlreadyEncrypted(row.value)) {
        skipped++
        continue
      }
      if (dryRun) {
        encrypted++
        continue
      }
      const ciphertext = encryptToken(row.value, encKey!, 'CREDENTIAL_ENC_KEY')
      await db
        .update(schema.userCredentials)
        .set({ value: ciphertext })
        .where(
          and(
            eq(schema.userCredentials.userId, row.userId),
            eq(schema.userCredentials.provider, row.provider),
          ),
        )
      encrypted++
    } catch (err) {
      failures.push({
        userId: row.userId,
        provider: row.provider,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  console.log(
    `[reencrypt] ${dryRun ? 'DRY-RUN ' : ''}total=${rows.length} ` +
      `${dryRun ? 'would-encrypt' : 'encrypted'}=${encrypted} ` +
      `already-encrypted=${skipped} failures=${failures.length}`,
  )
  if (failures.length) {
    console.error('[reencrypt] failures (investigate — likely a key mismatch):')
    for (const f of failures) console.error(`  ${f.userId} / ${f.provider}: ${f.reason}`)
  }
  await closeDb()
  if (failures.length) process.exit(1)
}

main().catch((err) => {
  console.error('[reencrypt] fatal:', err)
  process.exit(1)
})
