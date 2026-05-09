import { describe, it, expect, vi } from 'vitest'
import { validateUrlForFetch, isPrivateIp } from '../main/security/url-allowlist'

/**
 * URL validation is a security-critical chokepoint for the agent's web_fetch
 * tool. Tests cover: protocol/host rejection (no DNS needed), private-IP
 * literals (no DNS), DNS-resolved private IPs, DNS timeout (3s), DNS failure,
 * and happy path.
 *
 * DNS calls are mocked via vi.mock so tests are hermetic and fast.
 */

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

import { lookup } from 'node:dns/promises'

const mockLookup = vi.mocked(lookup)

function mockResolve(addresses: string[], family = 4): void {
  mockLookup.mockResolvedValueOnce(addresses.map(address => ({ address, family })) as never)
}

function mockReject(err: Error): void {
  mockLookup.mockRejectedValueOnce(err)
}

function mockHang(): void {
  // Promise that never resolves — withTimeout in the validator must reject
  // independently after 3s. Tests use vi fake timers to advance that 3s.
  mockLookup.mockImplementationOnce(() => new Promise(() => {}))
}

describe('validateUrlForFetch — protocol/host (no DNS)', () => {
  it('rejects non-https protocols', async () => {
    expect(await validateUrlForFetch('http://example.com/x')).toEqual({
      ok: false, code: 'unsafe_protocol', message: expect.stringContaining('http:'),
    })
    expect(await validateUrlForFetch('ftp://example.com/x')).toMatchObject({ ok: false, code: 'unsafe_protocol' })
    expect(await validateUrlForFetch('file:///etc/passwd')).toMatchObject({ ok: false, code: 'unsafe_protocol' })
    expect(await validateUrlForFetch('data:text/html,<script>...</script>')).toMatchObject({ ok: false, code: 'unsafe_protocol' })
  })

  it('rejects malformed URLs', async () => {
    expect(await validateUrlForFetch('not a url')).toMatchObject({ ok: false, code: 'invalid_url' })
    expect(await validateUrlForFetch('https://')).toMatchObject({ ok: false, code: 'invalid_url' })
  })

  it('rejects literal private IPv4 addresses without DNS', async () => {
    const cases = [
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://172.16.0.1/x',
      'https://172.31.255.255/x',
      'https://169.254.169.254/latest',  // AWS IMDS — classic SSRF target
      'https://0.0.0.0/x',
      'https://100.64.0.1/x',  // CGNAT
    ]
    for (const url of cases) {
      const result = await validateUrlForFetch(url)
      expect(result, `expected ${url} to be rejected`).toMatchObject({ ok: false, code: 'private_ip' })
    }
    // No DNS calls should have been made for IP literals.
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('rejects literal private IPv6 addresses without DNS', async () => {
    const cases = [
      'https://[::1]/x',
      'https://[fe80::1]/x',     // link-local
      'https://[fc00::1]/x',     // unique local
      'https://[fd12:3456::1]/x',
      'https://[::ffff:127.0.0.1]/x', // IPv4-mapped loopback
    ]
    for (const url of cases) {
      const result = await validateUrlForFetch(url)
      expect(result, `expected ${url} to be rejected`).toMatchObject({ ok: false, code: 'private_ip' })
    }
    expect(mockLookup).not.toHaveBeenCalled()
  })
})

describe('validateUrlForFetch — DNS resolution', () => {
  it('accepts a public hostname resolving to a public IP', async () => {
    mockResolve(['142.250.80.78'])
    const result = await validateUrlForFetch('https://www.google.com/')
    expect(result).toMatchObject({ ok: true, hostname: 'www.google.com' })
  })

  it('rejects a hostname that resolves to a private IP', async () => {
    mockResolve(['10.0.0.1'])
    const result = await validateUrlForFetch('https://internal.corp/admin')
    expect(result).toMatchObject({ ok: false, code: 'private_ip' })
  })

  it('rejects when ANY resolved address is private (mixed pool)', async () => {
    mockResolve(['142.250.80.78', '127.0.0.1'])
    const result = await validateUrlForFetch('https://shifty.example/')
    expect(result).toMatchObject({ ok: false, code: 'private_ip' })
  })

  it('reports dns_failed on resolution error', async () => {
    mockReject(new Error('ENOTFOUND'))
    const result = await validateUrlForFetch('https://nope.invalid/')
    expect(result).toMatchObject({ ok: false, code: 'dns_failed' })
  })

  it('reports dns_timeout when lookup hangs longer than 3s', async () => {
    vi.useFakeTimers()
    try {
      mockHang()
      const promise = validateUrlForFetch('https://slow.example/')
      // Advance past the 3000ms timeout in withTimeout.
      await vi.advanceTimersByTimeAsync(3001)
      const result = await promise
      expect(result).toMatchObject({ ok: false, code: 'dns_timeout' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isPrivateIp — direct exports', () => {
  it('is true for representative private ranges', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('10.255.255.254')).toBe(true)
    expect(isPrivateIp('172.20.0.1')).toBe(true)
    expect(isPrivateIp('192.168.0.1')).toBe(true)
    expect(isPrivateIp('169.254.169.254')).toBe(true)
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fe80::1')).toBe(true)
  })

  it('is false for representative public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('142.250.80.78')).toBe(false)
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false) // Cloudflare DNS
  })

  it('is true for malformed addresses (fail-closed)', () => {
    expect(isPrivateIp('300.500.0.1')).toBe(true)
    expect(isPrivateIp('not-an-ip')).toBe(true)
  })
})
