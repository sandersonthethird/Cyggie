import { randomBytes, createHash } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'

// Server-side store for in-flight OAuth round-trips, persisted to the
// `oauth_pending` Neon table. Entries live for 15 minutes; the callback
// consumes them once.
//
// Why Postgres (not an in-memory Map):
//   • POST /auth/google/start and GET /auth/google/callback can land on
//     different Fly machines under HA — the original Map only worked when
//     the gateway ran a single instance (the bug we hit during M1a Step 8).
//   • Survives a gateway restart mid-OAuth (Fly redeploys, scale events).
//   • Periodic SELECT...DELETE WHERE expires_at < now() reclaims storage
//     cheaply (15min TTL × low traffic = bounded row count).
//
// Why 15min (was 5min): the state is single-use (DELETE RETURNING is atomic)
// and PKCE-bound, so a longer window doesn't expand the attack surface
// meaningfully. The actual scarcity is the user's attention span — a user
// who context-switches mid-flow shouldn't lose their session.

const TTL_MS = 15 * 60 * 1000

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  // RFC 7636: base64url-encoded 32 bytes
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { codeVerifier: verifier, codeChallenge: challenge }
}

export function generateState(): string {
  return randomBytes(24).toString('base64url')
}

export type RedirectTarget = 'mobile' | 'desktop'

export interface PendingOAuth {
  codeVerifier: string
  deviceId: string
  deviceLabel: string | null
  redirectTarget: RedirectTarget
}

export async function rememberPending(opts: {
  databaseUrl: string
  state: string
  codeVerifier: string
  deviceId: string
  deviceLabel: string | null
  redirectTarget?: RedirectTarget
}): Promise<void> {
  const db = getDb(opts.databaseUrl)
  await db.insert(schema.oauthPending).values({
    state: opts.state,
    codeVerifier: opts.codeVerifier,
    deviceId: opts.deviceId,
    deviceLabel: opts.deviceLabel,
    redirectTarget: opts.redirectTarget ?? 'mobile',
    expiresAt: new Date(Date.now() + TTL_MS),
  })
}

export async function consumePending(opts: {
  databaseUrl: string
  state: string
}): Promise<PendingOAuth | null> {
  const db = getDb(opts.databaseUrl)
  // DELETE RETURNING: atomic single-use semantics. Even with two concurrent
  // callbacks for the same state, only one wins the row.
  const now = new Date()
  const [row] = await db
    .delete(schema.oauthPending)
    .where(eq(schema.oauthPending.state, opts.state))
    .returning()
  if (!row) return null
  if (row.expiresAt.getTime() < now.getTime()) return null
  const target = row.redirectTarget === 'desktop' ? 'desktop' : 'mobile'
  return {
    codeVerifier: row.codeVerifier,
    deviceId: row.deviceId,
    deviceLabel: row.deviceLabel,
    redirectTarget: target,
  }
}

// Periodic cleanup. Runs every 5 min. With node-linker=hoisted + single Fly
// machine right now, one sweeper per process is fine. If we go HA, each
// instance sweeps — DELETE is idempotent so no coordination needed.
let sweeperHandle: NodeJS.Timeout | null = null

export function startPendingSweeper(databaseUrl: string): void {
  if (sweeperHandle) return
  const sweep = async () => {
    try {
      const db = getDb(databaseUrl)
      await db.delete(schema.oauthPending).where(lt(schema.oauthPending.expiresAt, new Date()))
    } catch {
      // Sweep is best-effort. Don't crash the gateway if Neon is briefly
      // unreachable — the next sweep will catch up.
    }
  }
  // Stagger the first run so concurrent gateway boots don't all hit Neon at
  // the same second.
  setTimeout(sweep, 30_000 + Math.floor(Math.random() * 30_000))
  sweeperHandle = setInterval(sweep, TTL_MS)
  sweeperHandle.unref()
}

export function stopPendingSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle)
    sweeperHandle = null
  }
}

// Re-export so test fixtures can wipe the table directly.
export const _testOnly = {
  TTL_MS,
  and,
}
