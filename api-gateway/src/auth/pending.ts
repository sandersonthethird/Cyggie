import { randomBytes, createHash } from 'node:crypto'

// In-memory store for pending OAuth flows (between `/auth/google/start` and the
// callback at `/auth/google/callback`). Each entry lives for 5 minutes; the
// callback consumes it once.
//
// TODO (before production deploy): move to an `oauth_pending` table on Neon so
// that a gateway restart doesn't break in-flight signins, and so we can scale
// past one instance. Single-Map storage is fine for V1 dev / single-instance Fly.

interface PendingOAuth {
  codeVerifier: string
  deviceId: string
  deviceLabel: string | null
  createdAt: number
}

const TTL_MS = 5 * 60 * 1000
const store = new Map<string, PendingOAuth>()

// Periodic cleanup. Runs every minute, drops expired entries. Stays alive for the
// process lifetime; deliberate — no need to unref since this is a foreground service.
setInterval(() => {
  const now = Date.now()
  for (const [state, entry] of store) {
    if (now - entry.createdAt > TTL_MS) store.delete(state)
  }
}, 60_000).unref()

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  // RFC 7636: base64url-encoded 32 bytes
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { codeVerifier: verifier, codeChallenge: challenge }
}

export function generateState(): string {
  return randomBytes(24).toString('base64url')
}

export function rememberPending(opts: {
  state: string
  codeVerifier: string
  deviceId: string
  deviceLabel: string | null
}): void {
  store.set(opts.state, {
    codeVerifier: opts.codeVerifier,
    deviceId: opts.deviceId,
    deviceLabel: opts.deviceLabel,
    createdAt: Date.now(),
  })
}

export function consumePending(state: string): PendingOAuth | null {
  const entry = store.get(state)
  if (!entry) return null
  store.delete(state)
  if (Date.now() - entry.createdAt > TTL_MS) return null
  return entry
}
