/**
 * URL safety validator for the agent's `web_fetch` tool.
 *
 * The agent autonomously chooses URLs to fetch, which is a known SSRF vector
 * and an exfiltration channel. Without validation, the agent can be steered
 * (via prompt injection in tool results) to fetch attacker-controlled URLs
 * encoding leaked data, or to hit private/loopback IPs in real network
 * environments.
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Validation pipeline (validateUrlForFetch):                  │
 *   │                                                              │
 *   │  1. Parse → invalid URL?           reject 'invalid_url'      │
 *   │  2. Protocol → not 'https:'?       reject 'unsafe_protocol'  │
 *   │  3. No host?                       reject 'no_host'          │
 *   │  4. Host literal IP → blocked?     reject 'private_ip'       │
 *   │  5. DNS resolve (3s timeout) →                               │
 *   │       any returned IP private/lb?  reject 'private_ip'       │
 *   │       DNS hung > 3s?               reject 'dns_timeout'      │
 *   │       resolution failed?           reject 'dns_failed'       │
 *   │                                                              │
 *   │  Returns { ok: true, hostname } on pass; { ok: false, code,  │
 *   │  message } on reject. Never throws.                           │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Blocked CIDR ranges:
 *   IPv4: 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
 *         192.168.0.0/16, 0.0.0.0/8 (current network), 100.64.0.0/10 (CGNAT)
 *   IPv6: ::1/128 (loopback), fc00::/7 (unique local), fe80::/10 (link-local),
 *         ::/128 (unspecified), ::ffff:0:0/96 (IPv4-mapped — re-checked as IPv4)
 *
 * The 3s DNS timeout exists because the default `dns.lookup` has no timeout;
 * a slow or hung resolver would otherwise stall the agent loop indefinitely.
 */

import { lookup } from 'node:dns/promises'
import { isIPv4, isIPv6 } from 'node:net'

export type UrlValidationResult =
  | { ok: true; hostname: string; resolvedAddresses: string[] }
  | { ok: false; code: UrlRejectionCode; message: string }

export type UrlRejectionCode =
  | 'invalid_url'
  | 'unsafe_protocol'
  | 'no_host'
  | 'private_ip'
  | 'dns_timeout'
  | 'dns_failed'

const DNS_TIMEOUT_MS = 3000

export async function validateUrlForFetch(input: string): Promise<UrlValidationResult> {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, code: 'invalid_url', message: `not a valid URL: ${truncate(input, 80)}` }
  }

  if (url.protocol !== 'https:') {
    return { ok: false, code: 'unsafe_protocol', message: `protocol must be https; got ${url.protocol}` }
  }

  const hostname = url.hostname
  if (!hostname) {
    return { ok: false, code: 'no_host', message: 'URL has no host' }
  }

  // If the host is a literal IP, validate it directly.
  if (looksLikeIp(hostname)) {
    const cleaned = stripIpv6Brackets(hostname)
    if (isPrivateIp(cleaned)) {
      return { ok: false, code: 'private_ip', message: `host resolves to private IP: ${cleaned}` }
    }
    return { ok: true, hostname, resolvedAddresses: [cleaned] }
  }

  // Otherwise resolve via DNS, with a hard timeout. We use `lookup` with `all:true`
  // so we catch any returned address being private (some hosts return mixed pools).
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await withTimeout(lookup(hostname, { all: true }), DNS_TIMEOUT_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'dns_timeout') {
      return { ok: false, code: 'dns_timeout', message: `DNS lookup for ${hostname} exceeded ${DNS_TIMEOUT_MS}ms` }
    }
    return { ok: false, code: 'dns_failed', message: `DNS lookup for ${hostname} failed: ${message}` }
  }

  const resolved = addresses.map(a => a.address)
  for (const addr of resolved) {
    if (isPrivateIp(addr)) {
      return {
        ok: false,
        code: 'private_ip',
        message: `host ${hostname} resolves to private IP: ${addr}`,
      }
    }
  }

  return { ok: true, hostname, resolvedAddresses: resolved }
}

/**
 * Promise.race style timeout that throws an `Error('dns_timeout')` if the
 * inner promise hasn't settled within `ms`. Inner promise is left running
 * (DNS lookups can't be canceled cleanly via the Node API), but the outer
 * promise rejects so callers can move on.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns_timeout')), ms)
    p.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * Decide whether a URL host should skip DNS resolution. Strips IPv6 brackets
 * if present and returns true when the inner string is a valid literal IP.
 */
function looksLikeIp(host: string): boolean {
  const cleaned = stripIpv6Brackets(host)
  return isIPv4(cleaned) || isIPv6(cleaned)
}

function stripIpv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1)
  return host
}

/**
 * Private/loopback/link-local check for IPv4 and IPv6. Fail-closed: any input
 * that isn't a recognizable IPv4 or IPv6 address is treated as private (we'd
 * rather refuse a malformed input than leak through it).
 */
export function isPrivateIp(addr: string): boolean {
  if (isIPv4(addr)) return isPrivateIpv4(addr)
  if (isIPv6(addr)) return isPrivateIpv6(addr.toLowerCase())
  return true // unrecognized shape → fail closed
}

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split('.').map(Number)
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
    // Malformed address — refuse to fetch from it.
    return true
  }
  const [a, b] = parts
  if (a === 0) return true                       // 0.0.0.0/8 current network
  if (a === 10) return true                      // 10.0.0.0/8 private
  if (a === 127) return true                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true        // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true        // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
  return false
}

function isPrivateIpv6(addr: string): boolean {
  // Loopback, unspecified
  if (addr === '::1' || addr === '::') return true
  // Block ALL IPv4-mapped IPv6 (::ffff:*) — these are loopback/private IPv4
  // addresses dressed up as IPv6, and the only legitimate use cases for the
  // agent's web_fetch wouldn't go through this form. Covers both:
  //   ::ffff:127.0.0.1   (mixed dotted)
  //   ::ffff:7f00:1      (canonical hex; URL parser may normalize to this)
  if (addr.startsWith('::ffff:')) return true
  // Unique local fc00::/7 (first byte 0xfc or 0xfd)
  if (/^fc[0-9a-f]{2}:|^fd[0-9a-f]{2}:/.test(addr)) return true
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true
  return false
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
