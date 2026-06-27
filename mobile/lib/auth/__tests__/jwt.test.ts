import { describe, expect, it } from 'vitest'
import { accessTokenExpiringWithin, decodeJwtPayload } from '../jwt'

// Build a JWT-shaped string (header.payload.signature) with a base64url payload.
// Signature is irrelevant — these helpers never verify it.
function makeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`
}

const SECOND = 1000

describe('decodeJwtPayload', () => {
  it('decodes a base64url payload', () => {
    expect(decodeJwtPayload(makeToken({ exp: 123, sub: 'u1' }))).toEqual({ exp: 123, sub: 'u1' })
  })

  it('returns null for a non-3-part token', () => {
    expect(decodeJwtPayload('not.ajwt')).toBeNull()
  })

  it('returns null for an unparseable payload', () => {
    expect(decodeJwtPayload('h.@@@notbase64@@@.s')).toBeNull()
  })
})

describe('accessTokenExpiringWithin', () => {
  const now = Date.now()

  it('returns true for a null token', () => {
    expect(accessTokenExpiringWithin(null, 60_000)).toBe(true)
  })

  it('returns true for a malformed token', () => {
    expect(accessTokenExpiringWithin('garbage', 60_000)).toBe(true)
  })

  it('returns true when the payload has no exp', () => {
    expect(accessTokenExpiringWithin(makeToken({ sub: 'u1' }), 60_000)).toBe(true)
  })

  it('returns false for a token comfortably in the future', () => {
    const exp = Math.floor((now + 10 * 60 * SECOND) / 1000) // +10 min
    expect(accessTokenExpiringWithin(makeToken({ exp }), 60_000)).toBe(false)
  })

  it('returns true for an already-expired token', () => {
    const exp = Math.floor((now - 60 * SECOND) / 1000) // -1 min
    expect(accessTokenExpiringWithin(makeToken({ exp }), 60_000)).toBe(true)
  })

  it('returns true for a token expiring within the skew window', () => {
    const exp = Math.floor((now + 30 * SECOND) / 1000) // +30s, skew 60s
    expect(accessTokenExpiringWithin(makeToken({ exp }), 60_000)).toBe(true)
  })
})
