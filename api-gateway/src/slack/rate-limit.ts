// IP-based rate limiter for POST /slack/events (slice 1).
//
// Plan decision-log #18: 100 requests/minute per IP on /slack/events.
// In-memory sliding window — single-machine V1 is fine. Multi-firm
// moves this to Redis (same TODO that covers the OAuth limiter).
//
// Separate from the OAuth /oauth/register limiter
// (api-gateway/src/oauth/rate-limit.ts) so that abuse on one surface
// doesn't poison the other's bucket — different attackers, different
// blast radii. The shared factory at shared/sliding-window-limiter.ts
// supplies the algorithm; this file just owns the Slack-specific
// constants and re-exports the bound functions under the names the
// callers expect.

import type { FastifyInstance } from 'fastify'
import {
  makeSlidingWindowLimiter,
  type RateLimitDecision,
} from '../shared/sliding-window-limiter'

export type { RateLimitDecision }

const limiter = makeSlidingWindowLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  cleanupIntervalMs: 5 * 60 * 1000,
})

export function checkSlackEventsRateLimit(ip: string): RateLimitDecision {
  return limiter.check(ip)
}

export function registerSlackRateLimiter(app: FastifyInstance): void {
  limiter.register(app)
}

// Test helper.
export function _resetSlackRateLimiterForTests(): void {
  limiter._resetForTests()
}
