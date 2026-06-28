import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Symmetric AES-256-GCM envelope used for two at-rest secrets, each with its
// OWN key (separate blast radius):
//   • Google OAuth refresh tokens     → env.GOOGLE_TOKEN_ENC_KEY (auth/calendar)
//   • user_credentials provider keys  → env.CREDENTIAL_ENC_KEY  (Slice C)
//
// WHY THIS EXISTS
// ---------------
// To refresh a Google access token server-side you must replay the *original*
// refresh token to Google's token endpoint — so it has to be recoverable. The
// previous implementation ran it through a one-way SHA-256 hash (auth.ts
// `hashForStorage`), which destroyed it: the gateway could never refresh, so
// every ~1h access-token expiry forced a full re-consent. We trade that
// irreversibility for AES-256-GCM encryption whose key lives only in Fly
// secrets — a separate trust domain from Neon, so a DB leak alone yields nothing
// usable. The same primitive now also protects provider API keys (Slice C).
//
// The functions take the key as a parameter (and an optional `keyName` label so
// error messages name the right env var), so callers pick which secret domain
// they're in. The legacy/tamper distinction (TokenCryptoError.kind) lets the
// credential resolver tolerate Red Swan's pre-encryption plaintext rows
// (kind:'legacy' → use verbatim, transitional) while alarming on a real decrypt
// failure (kind:'decrypt_failed' → Sentry + surface error, never use).
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

/** Discriminates the three failure modes so callers can branch:
 *   'legacy'        — not iv:tag:ct shaped (pre-encryption plaintext / hash).
 *   'decrypt_failed'— GCM auth failure: wrong key or tampered ciphertext (ALARM).
 *   'bad_key'       — the configured env key isn't 32 bytes (misconfiguration). */
export type TokenCryptoErrorKind = 'legacy' | 'decrypt_failed' | 'bad_key'

export class TokenCryptoError extends Error {
  readonly kind: TokenCryptoErrorKind
  constructor(message: string, kind: TokenCryptoErrorKind) {
    super(message)
    this.name = 'TokenCryptoError'
    this.kind = kind
  }
}

// Decode + validate the env key once per call site. base64 of 32 random bytes.
// Throwing here (rather than at module load) keeps the failure close to the
// operation and avoids import-time side effects in tests. `keyName` names the
// env var in the error so a credential-key misconfig doesn't read as a Google one.
function loadKey(encKey: string, keyName: string): Buffer {
  const key = Buffer.from(encKey, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `${keyName} must decode to ${KEY_BYTES} bytes, got ${key.length}`,
      'bad_key',
    )
  }
  return key
}

/** Encrypt a plaintext secret → `iv:authTag:ciphertext` (all base64url).
 *  `keyName` only labels error messages (defaults to the Google-token key). */
export function encryptToken(
  plaintext: string,
  encKey: string,
  keyName = 'GOOGLE_TOKEN_ENC_KEY',
): string {
  const key = loadKey(encKey, keyName)
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
 * Throws `TokenCryptoError` with a `kind`:
 *   - 'legacy'         — not 3 colon-delimited parts (pre-encryption value).
 *   - 'decrypt_failed' — GCM auth failure (wrong key or tampered ciphertext).
 *   - 'bad_key'        — env key not 32 bytes.
 * Callers branch on `.kind`: refresh-token paths flip needs_reauth on any throw;
 * the credential resolver tolerates 'legacy' (plaintext) but alarms on the rest.
 */
export function decryptToken(
  blob: string,
  encKey: string,
  keyName = 'GOOGLE_TOKEN_ENC_KEY',
): string {
  const parts = blob.split(':')
  if (parts.length !== 3) {
    throw new TokenCryptoError(
      'legacy or malformed value (expected iv:authTag:ciphertext)',
      'legacy',
    )
  }
  const key = loadKey(encKey, keyName)
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
    throw new TokenCryptoError(
      'decryption failed (wrong key or tampered ciphertext)',
      'decrypt_failed',
    )
  }
}
