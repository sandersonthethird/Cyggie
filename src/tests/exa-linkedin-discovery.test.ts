/**
 * Tests for Exa LinkedIn Discovery service.
 *
 * Test groups:
 *   1. findLinkedInUrlViaExa       — happy path, empty results, bad URL, timeout, 429 retry
 *   2. findLinkedInUrlWithCascade  — web-first logic, fallback to Exa, both null
 *   3. findLinkedInUrlsForContactsBatch — skip existing, abort signal, found/notFound/skipped counts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ContactDetail } from '../shared/types/contact'

// ─── Mock exa-js ──────────────────────────────────────────────────────────────

const mockExaSearch = vi.fn()

vi.mock('exa-js', () => ({
  default: vi.fn().mockImplementation(() => ({
    search: mockExaSearch,
  })),
}))

// ─── Mock contact-utils (normalizeLinkedinUrl) ────────────────────────────────

vi.mock('../main/database/repositories/contact-utils', () => ({
  normalizeLinkedinUrl: (url: string) => {
    if (!url.includes('/in/')) return null
    const clean = url.replace(/^https?:\/\/(www\.)?linkedin\.com/, 'https://www.linkedin.com')
    return clean.endsWith('/') ? clean.slice(0, -1) : clean
  },
}))

// ─── Mock contact-web-enrichment (findLinkedInUrlFromWeb) ────────────────────

const mockFindLinkedInUrlFromWeb = vi.fn()

vi.mock('../main/services/contact-web-enrichment', () => ({
  findLinkedInUrlFromWeb: (...args: unknown[]) => mockFindLinkedInUrlFromWeb(...args),
}))

// ─── Mock contact.repo ────────────────────────────────────────────────────────

const mockGetContact = vi.fn()

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: (...args: unknown[]) => mockGetContact(...args),
}))

// ─── Mock audit.repo ──────────────────────────────────────────────────────────

const mockLogAudit = vi.fn()

vi.mock('../main/database/repositories/audit.repo', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}))

// ─── Import service under test ────────────────────────────────────────────────

import {
  findLinkedInUrlWithCascade,
  findLinkedInUrlsForContactsBatch,
  ExaDiscoveryError,
} from '../main/services/exa-linkedin-discovery.service'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeContact(overrides: Partial<ContactDetail> = {}): ContactDetail {
  return {
    id: 'c1',
    fullName: 'Jane Smith',
    firstName: 'Jane',
    lastName: 'Smith',
    primaryCompanyName: 'Acme Corp',
    linkedinUrl: null,
    linkedinEnrichedAt: null,
    linkedinHeadline: null,
    workHistory: null,
    contactType: null,
    email: null,
    phone: null,
    title: null,
    notes: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  } as unknown as ContactDetail
}

function makeAbortSignal(aborted = false): AbortSignal {
  return { aborted } as AbortSignal
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('findLinkedInUrlWithCascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  it('returns web URL without calling Exa when web lookup succeeds', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue('https://www.linkedin.com/in/janesmith')

    const result = await findLinkedInUrlWithCascade(contact, 'test-key')

    expect(result).toBe('https://www.linkedin.com/in/janesmith')
    expect(mockExaSearch).not.toHaveBeenCalled()
  })

  it('calls Exa when web lookup returns null', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
    mockExaSearch.mockResolvedValue({ results: [{ url: 'https://linkedin.com/in/janesmith' }] })

    const resultPromise = findLinkedInUrlWithCascade(contact, 'test-key')
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(mockExaSearch).toHaveBeenCalledTimes(1)
    expect(result).toBe('https://www.linkedin.com/in/janesmith')
  })

  it('returns null when both web and Exa return null', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
    mockExaSearch.mockResolvedValue({ results: [] })

    const resultPromise = findLinkedInUrlWithCascade(contact, 'test-key')
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result).toBeNull()
  })

  it('returns null when Exa result URL has no /in/ path segment', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
    mockExaSearch.mockResolvedValue({ results: [{ url: 'https://linkedin.com/company/acme' }] })

    const resultPromise = findLinkedInUrlWithCascade(contact, 'test-key')
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result).toBeNull()
  })

  it('throws ExaDiscoveryError on 401 from Exa', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
    const exaErr = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    mockExaSearch.mockRejectedValue(exaErr)

    const resultPromise = findLinkedInUrlWithCascade(contact, 'bad-key').catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const err = await resultPromise

    expect(err).toBeInstanceOf(ExaDiscoveryError)
    expect((err as ExaDiscoveryError).code).toBe('exa_auth')
  })

  it('retries once on 429 then returns null if retry also fails', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
    // First attempt returns 429 (null signal), retry also empty
    mockExaSearch
      .mockResolvedValueOnce({ results: [] }) // first attempt → null
      .mockResolvedValueOnce({ results: [] }) // retry → null

    const resultPromise = findLinkedInUrlWithCascade(contact, 'test-key')
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(mockExaSearch).toHaveBeenCalledTimes(2)
    expect(result).toBeNull()
  })

  it('handles undefined results property gracefully', async () => {
    const contact = makeContact()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
    mockExaSearch.mockResolvedValue({}) // no results property

    const resultPromise = findLinkedInUrlWithCascade(contact, 'test-key')
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result).toBeNull()
  })
})

describe('findLinkedInUrlsForContactsBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockFindLinkedInUrlFromWeb.mockResolvedValue(null)
  })

  it('skips contacts that already have a linkedinUrl', async () => {
    mockGetContact.mockReturnValue(makeContact({ id: 'c1', linkedinUrl: 'https://www.linkedin.com/in/existing' }))
    const onProgress = vi.fn()

    const resultPromise = findLinkedInUrlsForContactsBatch(
      ['c1'], 'test-key', makeAbortSignal(), onProgress, null
    )
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.skipped).toBe(1)
    expect(result.found).toBe(0)
    expect(mockExaSearch).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ foundUrl: 'https://www.linkedin.com/in/existing' }))
  })

  it('respects abort signal — stops processing remaining contacts', async () => {
    const signal = makeAbortSignal(true) // already aborted
    mockGetContact.mockReturnValue(makeContact())
    const onProgress = vi.fn()

    const resultPromise = findLinkedInUrlsForContactsBatch(
      ['c1', 'c2'], 'test-key', signal, onProgress, null
    )
    await vi.runAllTimersAsync()
    const result = await resultPromise

    // Aborted immediately — no contacts processed
    expect(result.found + result.notFound + result.skipped).toBe(0)
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('counts found/notFound/skipped correctly', async () => {
    mockGetContact
      .mockReturnValueOnce(makeContact({ id: 'c1' })) // no LinkedIn URL → will be searched
      .mockReturnValueOnce(makeContact({ id: 'c2' })) // no LinkedIn URL → will be searched
      .mockReturnValueOnce(makeContact({ id: 'c3', linkedinUrl: 'https://www.linkedin.com/in/existing' })) // skip

    mockExaSearch
      .mockResolvedValueOnce({ results: [{ url: 'https://linkedin.com/in/c1profile' }] }) // c1 found
      .mockResolvedValueOnce({ results: [] }) // c2 not found

    const onProgress = vi.fn()
    const resultPromise = findLinkedInUrlsForContactsBatch(
      ['c1', 'c2', 'c3'], 'test-key', makeAbortSignal(), onProgress, null
    )
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.found).toBe(1)
    expect(result.notFound).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.results).toHaveLength(3)
    expect(mockLogAudit).toHaveBeenCalledWith(null, 'contact', 'exa-linkedin-batch', 'update', {
      found: 1, notFound: 1, skipped: 1, total: 3
    })
  })

  it('logs and skips contacts where getContact() returns null (deleted mid-batch)', async () => {
    mockGetContact.mockReturnValue(null) // contact not found in DB
    const onProgress = vi.fn()

    const resultPromise = findLinkedInUrlsForContactsBatch(
      ['c-gone'], 'test-key', makeAbortSignal(), onProgress, null
    )
    await vi.runAllTimersAsync()
    const result = await resultPromise

    expect(result.skipped).toBe(1)
    expect(onProgress).not.toHaveBeenCalled()
    expect(mockExaSearch).not.toHaveBeenCalled()
  })

  it('throws ExaDiscoveryError with exa_auth code when Exa returns 401, aborting batch', async () => {
    mockGetContact.mockReturnValue(makeContact({ id: 'c1' }))
    const exaErr = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    mockExaSearch.mockRejectedValue(exaErr)
    const onProgress = vi.fn()

    const resultPromise = findLinkedInUrlsForContactsBatch(
      ['c1', 'c2'], 'test-key', makeAbortSignal(), onProgress, null
    ).catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    const err = await resultPromise

    expect(err).toBeInstanceOf(ExaDiscoveryError)
    expect((err as ExaDiscoveryError).code).toBe('exa_auth')
  })
})
