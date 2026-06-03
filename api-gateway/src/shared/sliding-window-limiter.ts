// Sliding-window per-key rate limiter (in-memory).
//
// Factored out of slack/rate-limit.ts and oauth/rate-limit.ts (External
// Agents V1 code review cleanup). Both were implementing the same
// algorithm with different constants. Shared factory eliminates drift
// risk — when this moves to Redis for multi-firm, there's one place to
// edit.
//
// Use:
//   const slackLimiter = makeSlidingWindowLimiter({
//     windowMs: 60_000, max: 100, cleanupIntervalMs: 5 * 60_000,
//   })
//   const decision = slackLimiter.check(req.ip)
//   if (!decision.allowed) reply.code(429).header('Retry-After', String(decision.retryAfterSeconds)).send(...)
//   slackLimiter.register(app)   // wires the cleanup interval to onClose
//   slackLimiter._resetForTests() // test helper
//
// V1 single-machine assumption. Multi-firm moves the bucket store to
// Redis; the factory's surface stays the same so callers don't need to
// change.

import type { FastifyInstance } from 'fastify'

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds: number
}

export interface SlidingWindowLimiter {
  check(key: string): RateLimitDecision
  register(app: FastifyInstance): void
  _resetForTests(): void
}

export interface MakeSlidingWindowLimiterArgs {
  windowMs: number
  max: number
  cleanupIntervalMs: number
}

interface BucketState {
  timestamps: number[]
}

export function makeSlidingWindowLimiter(
  args: MakeSlidingWindowLimiterArgs,
): SlidingWindowLimiter {
  const { windowMs, max, cleanupIntervalMs } = args
  const buckets = new Map<string, BucketState>()

  return {
    check(key: string): RateLimitDecision {
      const now = Date.now()
      const bucket = buckets.get(key) ?? { timestamps: [] }
      bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)

      if (bucket.timestamps.length >= max) {
        const oldest = bucket.timestamps[0]
        const retryAfterMs = windowMs - (now - oldest)
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
        buckets.set(key, bucket)
        return { allowed: false, retryAfterSeconds }
      }

      bucket.timestamps.push(now)
      buckets.set(key, bucket)
      return { allowed: true, retryAfterSeconds: 0 }
    },

    register(app: FastifyInstance): void {
      const interval = setInterval(() => {
        const now = Date.now()
        for (const [key, bucket] of buckets) {
          const live = bucket.timestamps.filter((t) => now - t < windowMs)
          if (live.length === 0) buckets.delete(key)
          else bucket.timestamps = live
        }
      }, cleanupIntervalMs)
      // Don't keep the event loop alive solely for the cleanup tick.
      interval.unref?.()
      app.addHook('onClose', async () => {
        clearInterval(interval)
      })
    },

    _resetForTests(): void {
      buckets.clear()
    },
  }
}
