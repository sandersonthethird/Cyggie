/**
 * Tests for buildQueryCues()
 *
 * buildQueryCues is a pure function that converts a company's associated contacts
 * and domains into Gmail query objects. The key invariant (regression test):
 * it must NEVER fall back to a name-based phrase query — doing so causes false
 * positives for companies whose names are common English words (e.g. "Signal").
 *
 * Priority order:
 *   contactEmails present → contact queries (confidence 0.95)
 *   no contacts, domains present → domain queries (confidence 0.82)
 *   neither present → [] (no name fallback)
 */

import { describe, it, expect } from 'vitest'
import { buildQueryCues } from '../main/services/company-email-ingest.service'

const BASE_CUES = { companyId: 'c1', canonicalName: 'Signal', contactEmails: [], domains: [] }

describe('buildQueryCues', () => {
  it('returns [] when no contacts and no domains', () => {
    // Regression: must not fall back to name-based query
    const result = buildQueryCues({ ...BASE_CUES })
    expect(result).toEqual([])
  })

  it('never generates a name-based query regardless of canonicalName', () => {
    const result = buildQueryCues({ ...BASE_CUES, canonicalName: 'any common word' })
    expect(result.some((q) => q.reason.startsWith('name:'))).toBe(false)
  })

  it('returns contact queries when contacts present', () => {
    const result = buildQueryCues({ ...BASE_CUES, contactEmails: ['alice@x.com', 'bob@y.com'] })
    expect(result.length).toBeGreaterThan(0)
    expect(result.every((q) => q.reason.startsWith('contacts:'))).toBe(true)
  })

  it('assigns confidence 0.95 to contact queries', () => {
    const result = buildQueryCues({ ...BASE_CUES, contactEmails: ['alice@x.com'] })
    expect(result[0].confidence).toBe(0.95)
  })

  it('returns domain queries when only domain present', () => {
    const result = buildQueryCues({ ...BASE_CUES, domains: ['signal.co'] })
    expect(result.length).toBe(1)
    expect(result[0].reason).toBe('domain:signal.co')
  })

  it('assigns confidence 0.82 to domain queries', () => {
    const result = buildQueryCues({ ...BASE_CUES, domains: ['signal.co'] })
    expect(result[0].confidence).toBe(0.82)
  })

  it('prefers contact queries over domain queries when both present', () => {
    const result = buildQueryCues({
      ...BASE_CUES,
      contactEmails: ['alice@x.com'],
      domains: ['signal.co']
    })
    expect(result.every((q) => q.reason.startsWith('contacts:'))).toBe(true)
    expect(result.some((q) => q.reason.startsWith('domain:'))).toBe(false)
  })

  it('chunks contact emails into groups of 8', () => {
    const emails = Array.from({ length: 10 }, (_, i) => `user${i}@x.com`)
    const result = buildQueryCues({ ...BASE_CUES, contactEmails: emails })
    expect(result.length).toBe(2)
  })

  it('produces one query per domain, not one per company', () => {
    // Each domain gets its own query object
    const result = buildQueryCues({ ...BASE_CUES, domains: ['signal.co', 'acme.com'] })
    expect(result.length).toBe(2)
    expect(result.map((q) => q.reason)).toEqual(['domain:signal.co', 'domain:acme.com'])
  })
})
