import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Symmetric encryption for Google OAuth refresh tokens stored at rest in
// oauth_tokens.refresh_token_encrypted.
//
// WHY THIS EXISTS
// ---------------
// To refresh a Google access token server-side you must replay the *original*
// refresh token to Google's token endpoint — so it has to be recoverable. The
// previous implementation ran it through a one-way SHA-256 hash (auth.ts
// `hashForStorage`), which destroyed it: the gateway could never refresh, so
// every ~1h access-token expiry forced a full re-consent. We trade that
// irreversibility for AES-256-GCM encryption whose key lives only in Fly
// secrets (env.GOOGLE_TOKEN_ENC_KEY) — a separate trust domain from Neon, so a
// DB leak alone yields nothing usable.
//
// FORMAT
// ------
// `iv:authTag:ciphertext`, each part base64url. The colon delimiter is the
// discriminator against legacy rows: a SHA-256 hex digest (64 hex chars) and a
// base64url access token both contain NO colon, so any stored value without two
// colons is treated as un-decryptable → the caller flips needs_reauth and the
// user re-consents once (which re-stores a real encrypted token).
//
//   plaintext ──encryptToken──▶ "iv:tag:ct"  ──persist──▶ refresh_token_encrypted
//   refresh_token_encrypted ──decryptToken──▶ plaintext (or THROW on legacy/tamper)

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard nonce length
const KEY_BYTES = 32 // AES-256

export class TokenCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenCryptoError'
  }
}

// Decode + validate the env key once per call site. base64 of 32 random bytes.
// Throwing here (rather than at module load) keeps the failure close to the
// operation and avoids import-time side effects in tests.
function loadKey(encKey: string): Buffer {
  const key = Buffer.from(encKey, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `GOOGLE_TOKEN_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`,
    )
  }
  return key
}

/** Encrypt a plaintext token → `iv:authTag:ciphertext` (all base64url). */
export function encryptToken(plaintext: string, encKey: string): string {
  const key = loadKey(encKey)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':')
}

/**
 * Decrypt an `iv:authTag:ciphertext` blob back to plaintext.
 *
 * Throws `TokenCryptoError` on a legacy/malformed value (not 3 colon-delimited
 * parts) and on GCM auth failure (wrong key or tampered ciphertext). Both mean
 * "this refresh token is unusable" — callers should flip needs_reauth. The two
 * cases are distinguishable by message for ops (legacy = expected one-time
 * migration; auth failure = possible key misconfiguration / mass-logout signal).
 */
export function decryptToken(blob: string, encKey: string): string {
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new TokenCryptoError('legacy or malformed token (expected iv:authTag:ciphertext)')
  }
  const key = loadKey(encKey)
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const authTag = Buffer.from(tagB64, 'base64url')
  const ciphertext = Buffer.from(ctB64, 'base64url')
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // GCM final() throws on auth-tag mismatch — wrong key or tampering. Never
    // surface the underlying crypto error (could leak key/IV detail).
    throw new TokenCryptoError('token decryption failed (wrong key or tampered ciphertext)')
  }
}
