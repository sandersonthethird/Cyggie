// IP-based rate limiter for POST /slack/events (slice 1).
//
// Plan decision-log #18: 100 requests/minute per IP on /slack/events.
// In-memory sliding window — single-machine V1 is fine. Multi-firm
// moves this to Redis (same TODO that covers the OAuth limiter).
//
// Separate from the OAuth /oauth/register limiter
// (api-gateway/src/oauth/rate-limit.ts) so that abuse on one surface
// doesn't poison the other's bucket — different attackers, different
// blast radii.

import type { FastifyInstance } from 'fastify'

const WINDOW_MS = 60 * 1000 // 1 minute
const MAX_REQS_PER_IP = 100

interface BucketState {
  timestamps: number[]
}

const buckets = new Map<string, BucketState>()

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

export function checkSlackEventsRateLimit(ip: string): RateLimitDecision {
  const now = Date.now()
  const bucket = buckets.get(ip) ?? { timestamps: [] }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < WINDOW_MS)

  if (bucket.timestamps.length >= MAX_REQS_PER_IP) {
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

export function registerSlackRateLimiter(app: FastifyInstance): void {
  const interval = setInterval(
    () => {
      const now = Date.now()
      for (const [ip, bucket] of buckets) {
        const live = bucket.timestamps.filter((t) => now - t < WINDOW_MS)
        if (live.length === 0) buckets.delete(ip)
        else bucket.timestamps = live
      }
    },
    5 * 60 * 1000,
  )
  app.addHook('onClose', async () => {
    clearInterval(interval)
  })
}

// Test helper.
export function _resetSlackRateLimiterForTests(): void {
  buckets.clear()
}
