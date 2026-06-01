// Unit tests for slice 1 (External Agents V1) — Slack signing
// verification + rate limiter. Pure-function coverage; the full HTTP
// roundtrip lives in slack-smoke.test.ts.

import { afterEach, describe, expect, test } from 'vitest'
import {
  signSlackRequest,
  verifySlackSignature,
} from '../src/slack/signing'
import {
  checkSlackEventsRateLimit,
  _resetSlackRateLimiterForTests,
} from '../src/slack/rate-limit'

const SECRET = 'test-slack-signing-secret-32-chars-min'

describe('slack/signing: verifySlackSignature', () => {
  test('accepts a freshly-signed request', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody = '{"type":"event_callback","event":{"type":"app_mention"}}'
    const signature = signSlackRequest({
      signingSecret: SECRET,
      timestamp,
      rawBody,
    })
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp,
      rawBody,
    })
    expect(r.ok).toBe(true)
  })

  test('rejects request without timestamp', () => {
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature: 'v0=anything',
      timestamp: undefined,
      rawBody: '{}',
    })
    expect(r).toEqual({ ok: false, reason: 'missing_timestamp' })
  })

  test('rejects request without signature', () => {
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature: undefined,
      timestamp: String(Math.floor(Date.now() / 1000)),
      rawBody: '{}',
    })
    expect(r).toEqual({ ok: false, reason: 'missing_signature' })
  })

  test('rejects non-numeric timestamp', () => {
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature: 'v0=anything',
      timestamp: 'not-a-number',
      rawBody: '{}',
    })
    expect(r).toEqual({ ok: false, reason: 'missing_timestamp' })
  })

  test('rejects timestamp >5 min old (replay defense)', () => {
    const nowMs = 1_700_000_000_000
    const tooOldSec = Math.floor(nowMs / 1000) - 6 * 60 // 6 min ago
    const timestamp = String(tooOldSec)
    const rawBody = '{}'
    const signature = signSlackRequest({
      signingSecret: SECRET,
      timestamp,
      rawBody,
    })
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp,
      rawBody,
      nowMs,
    })
    expect(r).toEqual({ ok: false, reason: 'timestamp_too_old' })
  })

  test('accepts a timestamp at the edge of the window (just under 5 min)', () => {
    const nowMs = 1_700_000_000_000
    const justInsideSec = Math.floor(nowMs / 1000) - (5 * 60 - 1) // 4m59s ago
    const timestamp = String(justInsideSec)
    const rawBody = '{}'
    const signature = signSlackRequest({
      signingSecret: SECRET,
      timestamp,
      rawBody,
    })
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp,
      rawBody,
      nowMs,
    })
    expect(r.ok).toBe(true)
  })

  test('rejects timestamp meaningfully in the future', () => {
    const nowMs = 1_700_000_000_000
    const farFutureSec = Math.floor(nowMs / 1000) + 6 * 60
    const timestamp = String(farFutureSec)
    const rawBody = '{}'
    const signature = signSlackRequest({
      signingSecret: SECRET,
      timestamp,
      rawBody,
    })
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp,
      rawBody,
      nowMs,
    })
    expect(r).toEqual({ ok: false, reason: 'timestamp_in_future' })
  })

  test('rejects when body has been tampered with', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const originalBody = '{"hello":"world"}'
    const signature = signSlackRequest({
      signingSecret: SECRET,
      timestamp,
      rawBody: originalBody,
    })
    const tamperedBody = '{"hello":"evil"}'
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp,
      rawBody: tamperedBody,
    })
    expect(r).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  test('rejects when signing secret differs from issuer', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const rawBody = '{}'
    const signature = signSlackRequest({
      signingSecret: 'a-different-secret-from-the-real-one',
      timestamp,
      rawBody,
    })
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature,
      timestamp,
      rawBody,
    })
    expect(r).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  test('rejects signature with wrong length (timing-attack guard)', () => {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const r = verifySlackSignature({
      signingSecret: SECRET,
      signature: 'v0=tooShort',
      timestamp,
      rawBody: '{}',
    })
    expect(r).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})

describe('slack/rate-limit: checkSlackEventsRateLimit', () => {
  afterEach(() => {
    _resetSlackRateLimiterForTests()
  })

  test('allows up to 100 requests per IP per minute', () => {
    for (let i = 0; i < 100; i++) {
      const d = checkSlackEventsRateLimit('1.2.3.4')
      expect(d.allowed).toBe(true)
      expect(d.retryAfterSeconds).toBe(0)
    }
  })

  test('101st request from same IP within window is rejected', () => {
    for (let i = 0; i < 100; i++) {
      checkSlackEventsRateLimit('5.6.7.8')
    }
    const d = checkSlackEventsRateLimit('5.6.7.8')
    expect(d.allowed).toBe(false)
    expect(d.retryAfterSeconds).toBeGreaterThan(0)
    expect(d.retryAfterSeconds).toBeLessThanOrEqual(60)
  })

  test('different IPs have independent buckets', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkSlackEventsRateLimit('10.0.0.1').allowed).toBe(true)
    }
    expect(checkSlackEventsRateLimit('10.0.0.1').allowed).toBe(false)
    // Fresh IP, fresh bucket.
    expect(checkSlackEventsRateLimit('10.0.0.2').allowed).toBe(true)
  })
})
