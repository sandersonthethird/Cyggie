/**
 * Tests for normalizeDomain + extractDomainFromWebsiteUrl in email-parser.ts.
 * Locks in the dot-check rule that prevents bare tokens like "www" from being
 * stored as primary_domain.
 */
import { describe, it, expect } from 'vitest'
import { normalizeDomain, extractDomainFromWebsiteUrl } from '../main/utils/email-parser'

describe('normalizeDomain', () => {
  it('strips www. prefix and lowercases', () => {
    expect(normalizeDomain('www.Example.COM')).toBe('example.com')
  })

  it('passes a clean hostname through unchanged', () => {
    expect(normalizeDomain('lererhippeau.com')).toBe('lererhippeau.com')
  })

  it('strips https:// protocol', () => {
    expect(normalizeDomain('https://example.com')).toBe('example.com')
  })

  it('strips http:// protocol', () => {
    expect(normalizeDomain('http://example.com')).toBe('example.com')
  })

  it('strips path/query/fragment after the hostname', () => {
    expect(normalizeDomain('https://example.com/about/team?ref=foo')).toBe('example.com')
  })

  it('handles full URL + www together', () => {
    expect(normalizeDomain('https://www.lererhippeau.com/portfolio')).toBe('lererhippeau.com')
  })

  it('rejects bare tokens with no dot', () => {
    expect(normalizeDomain('www')).toBeNull()
    expect(normalizeDomain('abc')).toBeNull()
    expect(normalizeDomain('localhost')).toBeNull()
  })

  it('rejects empty / whitespace input', () => {
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain('   ')).toBeNull()
  })

  it('rejects null and undefined', () => {
    expect(normalizeDomain(null)).toBeNull()
    expect(normalizeDomain(undefined)).toBeNull()
  })

  it('rejects "https://" with no host', () => {
    expect(normalizeDomain('https://')).toBeNull()
  })

  it('rejects "www." (just the prefix)', () => {
    expect(normalizeDomain('www.')).toBeNull()
  })
})

describe('extractDomainFromWebsiteUrl', () => {
  it('extracts a registrable hostname from a full URL', () => {
    expect(extractDomainFromWebsiteUrl('https://www.lererhippeau.com')).toBe('lererhippeau.com')
  })

  it('handles a bare hostname (auto-prepends scheme)', () => {
    expect(extractDomainFromWebsiteUrl('lererhippeau.com')).toBe('lererhippeau.com')
  })

  it('handles a hostname with www (auto-prepends scheme)', () => {
    expect(extractDomainFromWebsiteUrl('www.lererhippeau.com')).toBe('lererhippeau.com')
  })

  it('returns null for "www" alone (regression: previously returned "www")', () => {
    expect(extractDomainFromWebsiteUrl('www')).toBeNull()
  })

  it('returns null for "https://www" (regression)', () => {
    expect(extractDomainFromWebsiteUrl('https://www')).toBeNull()
  })

  it('returns null for null/empty input', () => {
    expect(extractDomainFromWebsiteUrl(null)).toBeNull()
    expect(extractDomainFromWebsiteUrl('')).toBeNull()
    expect(extractDomainFromWebsiteUrl('   ')).toBeNull()
  })

  it('returns null when the URL constructor throws', () => {
    expect(extractDomainFromWebsiteUrl('not a url with spaces and \n newlines')).toBeNull()
  })
})
