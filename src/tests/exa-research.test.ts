import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setExaMockResponses, clearExaMocks, MockExa, buildExaError } from './helpers/exa-mocks'

vi.mock('exa-js', () => ({ Exa: MockExa }))

vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(),
}))

import { getCredential } from '../main/security/credentials'
import { searchCompanyContext, agentWebSearch, agentWebFetch } from '../main/services/exa-research'

const mockGetCredential = vi.mocked(getCredential)

describe('searchCompanyContext — pre-research for memo-generator', () => {
  beforeEach(() => {
    clearExaMocks()
    mockGetCredential.mockReset()
  })

  it('returns empty bundle when Exa key is not configured', async () => {
    mockGetCredential.mockReturnValue(null)
    const result = await searchCompanyContext({ companyName: 'Acme' })
    expect(result).toEqual({ queries: [], results: [] })
  })

  it('runs the expected 4-5 queries when industry is provided', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [{ url: 'https://e.com', text: 'snippet', title: 't' }] }
      },
    })
    const result = await searchCompanyContext({
      companyName: 'Acme',
      industry: 'fintech',
    })
    expect(seenQueries).toHaveLength(5)
    expect(seenQueries).toContain('"Acme" recent news')
    expect(seenQueries).toContain('fintech market size 2025')
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('omits the market-size query when industry is not provided', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({ companyName: 'Acme' })
    expect(seenQueries).toHaveLength(4)
    expect(seenQueries.find(q => q.includes('market size'))).toBeUndefined()
  })

  it('degrades silently when individual queries fail', async () => {
    mockGetCredential.mockReturnValue('test-key')
    let callCount = 0
    setExaMockResponses({
      searchAndContents: async () => {
        callCount += 1
        if (callCount <= 2) throw new Error('network')
        return { results: [{ url: 'https://e.com', text: 'snippet' }] }
      },
    })
    const result = await searchCompanyContext({ companyName: 'Acme' })
    // 2 failed + 2 succeeded (1 result each) → 2 results total
    expect(result.results.length).toBe(2)
  })

  it('truncates per-result text to ~1500 chars', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const longText = 'a'.repeat(5000)
    setExaMockResponses({
      searchAndContents: async () => ({
        results: [{ url: 'https://x.com', text: longText, title: 't' }],
      }),
    })
    const result = await searchCompanyContext({ companyName: 'Acme' })
    expect(result.results[0]!.text.length).toBeLessThan(1700)
    expect(result.results[0]!.text).toContain('truncated')
  })
})

describe('agentWebSearch', () => {
  beforeEach(() => { clearExaMocks(); mockGetCredential.mockReset() })

  it('returns error envelope when key missing', async () => {
    mockGetCredential.mockReturnValue(null)
    const result = await agentWebSearch('foo')
    expect(result).toMatchObject({ error: expect.stringContaining('API key') })
  })

  it('returns top results with truncated snippets', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({
      searchAndContents: async () => ({
        results: [
          { url: 'https://a.com', text: 'A'.repeat(2000), title: 'A' },
          { url: 'https://b.com', text: 'b body', title: 'B' },
        ],
      }),
    })
    const result = await agentWebSearch('q')
    expect(result).toMatchObject({ query: 'q' })
    if ('results' in result) {
      expect(result.results.length).toBe(2)
      expect(result.results[0]!.snippet.length).toBeLessThan(1700)
    }
  })

  it('maps 401 to specific error message', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({ throwError: buildExaError(401) })
    const result = await agentWebSearch('q')
    expect(result).toMatchObject({ error: expect.stringContaining('401') })
  })

  it('maps 429 to specific error message', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({ throwError: buildExaError(429) })
    const result = await agentWebSearch('q')
    expect(result).toMatchObject({ error: expect.stringContaining('429') })
  })
})

describe('agentWebFetch — URL validation gate', () => {
  beforeEach(() => { clearExaMocks(); mockGetCredential.mockReset() })

  it('rejects http:// without contacting Exa', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({
      contents: async () => {
        throw new Error('SHOULD NOT BE CALLED')
      },
    })
    const result = await agentWebFetch('http://example.com/x')
    expect(result).toMatchObject({ rejectionCode: 'unsafe_protocol' })
  })

  it('rejects literal private IP without contacting Exa', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({
      contents: async () => {
        throw new Error('SHOULD NOT BE CALLED')
      },
    })
    const result = await agentWebFetch('https://127.0.0.1/admin')
    expect(result).toMatchObject({ rejectionCode: 'private_ip' })
  })

  it('returns error envelope when key missing (after URL validation passes)', async () => {
    mockGetCredential.mockReturnValue(null)
    // Use an IP literal so DNS isn't called (test stays hermetic)
    const result = await agentWebFetch('https://8.8.8.8/x')
    expect(result).toMatchObject({ error: expect.stringContaining('API key') })
  })

  it('returns extracted text on happy path', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({
      contents: async () => ({
        results: [{ url: 'https://8.8.8.8/x', text: 'page body', title: 'T' }],
      }),
    })
    const result = await agentWebFetch('https://8.8.8.8/x')
    expect(result).toMatchObject({ text: 'page body', truncated: false })
  })

  it('marks truncated=true when text exceeds limit', async () => {
    mockGetCredential.mockReturnValue('test-key')
    setExaMockResponses({
      contents: async () => ({
        results: [{ url: 'https://8.8.8.8/x', text: 'X'.repeat(20_000), title: 'T' }],
      }),
    })
    const result = await agentWebFetch('https://8.8.8.8/x')
    expect(result).toMatchObject({ truncated: true })
  })
})
