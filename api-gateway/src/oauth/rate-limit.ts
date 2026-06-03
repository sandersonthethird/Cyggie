// IP-based rate limiter for /oauth/register.
//
// Plan decision-log: 10 registrations/hour per IP. Slack-bot-friendly,
// attacker-hostile. In-memory token bucket — single-machine V1 is fine.
// Multi-firm moves this to Redis (multi-firm follow-up).
//
// Registered as a Fastify lifecycle hook in addition to being called
// directly from the /oauth/reg route handler so the limit fires before
// we hand the request off to node-oidc-provider's heavier registration
// machinery. Algorithm lives in shared/sliding-window-limiter.ts.

import type { FastifyInstance } from 'fastify'
import {
  makeSlidingWindowLimiter,
  type RateLimitDecision,
} from '../shared/sliding-window-limiter'

export type { RateLimitDecision }

const limiter = makeSlidingWindowLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  cleanupIntervalMs: 15 * 60 * 1000,
})

export function checkRegistrationRateLimit(ip: string): RateLimitDecision {
  return limiter.check(ip)
}

export function registerOAuthRateLimiter(app: FastifyInstance): void {
  limiter.register(app)
}

// Test helper — exposed so unit tests can simulate window expiry without
// waiting an hour.
export function _resetRateLimiterForTests(): void {
  limiter._resetForTests()
}
