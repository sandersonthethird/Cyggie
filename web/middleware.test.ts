import { describe, it, expect, vi } from 'vitest'
import { generateNonce, middleware } from './middleware'

// Minimal NextRequest shape — middleware only reads .headers
type FakeReq = {
  headers: Headers
  nextUrl?: URL
  url?: string
}

function makeReq(): FakeReq {
  return { headers: new Headers(), url: 'https://example.test/' }
}

describe('generateNonce', () => {
  it('returns a non-empty base64-safe string', () => {
    const n = generateNonce()
    expect(typeof n).toBe('string')
    expect(n.length).toBeGreaterThanOrEqual(16)
    expect(n).toMatch(/^[A-Za-z0-9+/=]+$/)
  })

  it('produces distinct values on each call', () => {
    const a = generateNonce()
    const b = generateNonce()
    const c = generateNonce()
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('middleware CSP header', () => {
  it('sets Content-Security-Policy-Report-Only with a nonce', () => {
    const req = makeReq()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = middleware(req as any)
    const csp = response.headers.get('content-security-policy-report-only')
    expect(csp).not.toBeNull()
    expect(csp!).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
    expect(csp!).toMatch(/object-src 'none'/)
    expect(csp!).toMatch(/frame-ancestors 'none'/)
  })

  it('does not set the enforcing (non-Report-Only) CSP header', () => {
    const req = makeReq()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = middleware(req as any)
    expect(response.headers.get('content-security-policy')).toBeNull()
  })

  it('puts a distinct nonce on each request', () => {
    const r1 = middleware(makeReq() as never)
    const r2 = middleware(makeReq() as never)
    const csp1 = r1.headers.get('content-security-policy-report-only')!
    const csp2 = r2.headers.get('content-security-policy-report-only')!
    const n1 = csp1.match(/nonce-([^']+)'/)?.[1]
    const n2 = csp2.match(/nonce-([^']+)'/)?.[1]
    expect(n1).toBeDefined()
    expect(n2).toBeDefined()
    expect(n1).not.toBe(n2)
  })
})
