import { AppState, type AppStateStatus } from 'react-native'
import { GATEWAY_URL } from './client'

// =============================================================================
// warmup.ts — wake the gateway off the note-tap critical path.
//
// Notes are network-only, so the first note fetch after an app reload pays a
// stack of one-time cold-start costs (Fly machine wake on scale-to-zero, Neon
// compute autosuspend wake, lazy pg-pool + TLS init) that then stay warm. We
// move those costs to app launch / foreground by pinging an unauthenticated
// endpoint that exercises the whole path:
//
//   GET /health/ready  →  getPool().query('SELECT 1')
//     • any request wakes the Fly machine
//     • SELECT 1 wakes Neon compute + warms the gateway's lazy pg pool
//
// By the time the user navigates to a note, the server is warm and the fetch is
// a sub-100ms round-trip. Fire-and-forget — never throws, never blocks render.
// =============================================================================

const WARM_TIMEOUT_MS = 4000

let appStateSub: { remove: () => void } | null = null

/** Fire one warm-up ping. Swallows all errors (offline, cold gateway, abort). */
export function warmGateway(): void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WARM_TIMEOUT_MS)
  void fetch(`${GATEWAY_URL}/health/ready`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer))
}

/**
 * Warm on init AND on every foreground transition — the machine re-stops after
 * a few idle minutes, so returning to the app hits the same cold start as a
 * cold launch. De-duped so repeated signed-in effects don't stack listeners.
 * Mirrors the AppState trigger pattern in lib/sync/boot.ts.
 */
export function initGatewayWarmup(): void {
  warmGateway()
  if (appStateSub) return
  appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') warmGateway()
  })
}

export function shutdownGatewayWarmup(): void {
  if (appStateSub) {
    appStateSub.remove()
    appStateSub = null
  }
}
