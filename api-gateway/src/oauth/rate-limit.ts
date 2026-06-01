// IP-based rate limiter for /oauth/register.
//
// Plan decision-log: 10 registrations/hour per IP. Slack-bot-friendly,
// attacker-hostile. In-memory token bucket — single-machine V1 is fine.
// Multi-firm moves this to Redis (multi-firm follow-up).
//
// Registered as a Fastify lifecycle hook in addition to being called
// directly from the /oauth/reg route handler so the limit fires before
// we hand the request off to node-oidc-provider's heavier registration
// machinery.

import type { FastifyInstance } from 'fastify'

const WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_REGS_PER_IP = 10

interface BucketState {
  // Sliding-window timestamps of accepted registrations.
  timestamps: number[]
}

const buckets = new Map<string, BucketState>()

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

export function checkRegistrationRateLimit(ip: string): RateLimitDecision {
  const now = Date.now()
  const bucket = buckets.get(ip) ?? { timestamps: [] }
  // Prune timestamps outside the window.
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < WINDOW_MS)

  if (bucket.timestamps.length >= MAX_REGS_PER_IP) {
    const oldest = bucket.timestamps[0]
    const retryAfterMs = WINDOW_MS - (now - oldest)
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
    buckets.set(ip, bucket)
    return { allowed: false, retryAfterSeconds }
  }

  bucket.timestamps.push(now)
  buckets.set(ip, bucket)
  return { allowed: true, retryAfterSeconds: 0 }
}

// Periodic cleanup so the map doesn't grow without bound. Removes
// buckets with all timestamps outside the window. Cheap to run because
// `prune` work is amortized inside checkRegistrationRateLimit too.
export function registerOAuthRateLimiter(app: FastifyInstance): void {
  const interval = setInterval(
    () => {
      const now = Date.now()
      for (const [ip, bucket] of buckets) {
        const live = bucket.timestamps.filter((t) => now - t < WINDOW_MS)
        if (live.length === 0) buckets.delete(ip)
        else bucket.timestamps = live
      }
    },
    15 * 60 * 1000, // every 15 min
  )
  app.addHook('onClose', async () => {
    clearInterval(interval)
  })
}

// Test helper — exposed so unit tests can simulate window expiry without
// waiting an hour.
export function _resetRateLimiterForTests(): void {
  buckets.clear()
}
