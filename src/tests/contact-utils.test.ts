import { describe, it, expect } from 'vitest'
import { normalizeLinkedinUrl, extractLinkedinUrlsFromText } from '../main/database/repositories/contact-utils'

describe('normalizeLinkedinUrl', () => {
  // Protocol-less inputs — the main regression this test guards
  it('prepends https:// when URL starts with www.linkedin.com', () => {
    expect(normalizeLinkedinUrl('www.linkedin.com/in/foo')).toBe('https://www.linkedin.com/in/foo')
  })

  it('prepends https:// when URL starts with bare linkedin.com', () => {
    expect(normalizeLinkedinUrl('linkedin.com/in/foo')).toBe('https://linkedin.com/in/foo')
  })

  it('preserves trailing slash (not stripped by normalizeLinkedinUrl)', () => {
    // Trailing slash comparison is handled by toLinkedinSlug in the migration
    expect(normalizeLinkedinUrl('www.linkedin.com/in/foo/')).toBe('https://www.linkedin.com/in/foo/')
  })

  // Existing behaviour regressions
  it('upgrades http:// to https://', () => {
    expect(normalizeLinkedinUrl('http://linkedin.com/in/foo')).toBe('https://linkedin.com/in/foo')
  })

  it('leaves https:// URL unchanged', () => {
    expect(normalizeLinkedinUrl('https://linkedin.com/in/foo')).toBe('https://linkedin.com/in/foo')
  })

  it('strips query string', () => {
    expect(normalizeLinkedinUrl('https://linkedin.com/in/foo?trk=abc')).toBe(
      'https://linkedin.com/in/foo',
    )
  })

  it('returns null for non-linkedin URL', () => {
    expect(normalizeLinkedinUrl('https://notlinkedin.com/in/foo')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(normalizeLinkedinUrl('')).toBeNull()
  })
})

describe('extractLinkedinUrlsFromText', () => {
  it('finds a protocol-less LinkedIn URL in text', () => {
    const result = extractLinkedinUrlsFromText(
      'Connect with me: www.linkedin.com/in/sandersoncass',
    )
    expect(result).toEqual(['https://www.linkedin.com/in/sandersoncass'])
  })

  it('finds a standard https:// LinkedIn URL (regression)', () => {
    const result = extractLinkedinUrlsFromText(
      'Profile: https://linkedin.com/in/kathleen',
    )
    expect(result).toEqual(['https://linkedin.com/in/kathleen'])
  })

  it('returns multiple distinct URLs from the same text', () => {
    const result = extractLinkedinUrlsFromText(
      'Alice: https://linkedin.com/in/alice\nBob: www.linkedin.com/in/bob',
    )
    expect(result).toHaveLength(2)
    expect(result).toContain('https://linkedin.com/in/alice')
    expect(result).toContain('https://www.linkedin.com/in/bob')
  })

  it('deduplicates identical URLs appearing twice in the same text', () => {
    const result = extractLinkedinUrlsFromText(
      'Profile: https://linkedin.com/in/foo — also see https://linkedin.com/in/foo',
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toBe('https://linkedin.com/in/foo')
  })

  it('returns empty array for null input', () => {
    expect(extractLinkedinUrlsFromText(null)).toEqual([])
  })

  it('returns empty array when no LinkedIn URL present', () => {
    expect(extractLinkedinUrlsFromText('no links here')).toEqual([])
  })
})
