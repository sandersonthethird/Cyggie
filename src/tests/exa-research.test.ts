import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setExaMockResponses, clearExaMocks, MockExa, buildExaError } from './helpers/exa-mocks'

vi.mock('exa-js', () => ({ Exa: MockExa }))

vi.mock('../main/security/credentials', () => ({
  getCredential: vi.fn(),
}))

import { getCredential } from '../main/security/credentials'
import { searchCompanyContext, agentWebSearch, agentWebFetch } from '../main/services/exa-research'

const mockGetCredential = vi.mocked(getCredential)

describe('searchCompanyContext — niche-targeted pre-research for memo-generator', () => {
  beforeEach(() => {
    clearExaMocks()
    mockGetCredential.mockReset()
  })

  it('returns empty bundle when Exa key is not configured', async () => {
    mockGetCredential.mockReturnValue(null)
    const result = await searchCompanyContext({ companyName: 'Acme' })
    expect(result).toEqual({ queries: [], results: [] })
  })

  it('uses the meeting-derived nicheSignal as the niche query (preferred over description)', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      companyDescription: 'description fallback that should be ignored',
      nicheSignal: 'AI-driven invoice processing for mid-market SMBs in the US',
    })
    // The niche query is the FIRST query and uses the nicheSignal, not the description.
    expect(seenQueries[0]).toBe('AI-driven invoice processing for mid-market SMBs in the US')
    expect(seenQueries[0]).not.toContain('description fallback')
  })

  it('falls back to companyDescription when nicheSignal is empty', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      companyDescription: 'AI-driven invoice processing for SMBs',
    })
    expect(seenQueries[0]).toBe('AI-driven invoice processing for SMBs')
  })

  it('augments niche query with themes when present', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'invoice processing for SMBs',
      themes: ['fintech', 'infrastructure'],
    })
    expect(seenQueries[0]).toBe('invoice processing for SMBs (themes: fintech, infrastructure)')
  })

  it('skips niche query when both nicheSignal and description are stub-y (<20 chars)', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'too short',
      companyDescription: '',
      industry: 'fintech',
    })
    // Niche is skipped (both signals stub-y); industry + competitors fire.
    expect(seenQueries).toEqual([
      'fintech market size 2025',
      'fintech competitors alternatives',
    ])
  })

  it('quotes founder names in LinkedIn queries (caps at 2)', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      founderNames: ['Jane Doe', 'Sam Smith', 'Casey Lee', 'Robin Park', 'Alex Chen'],
    })
    expect(seenQueries).toContain('"Jane Doe" linkedin')
    expect(seenQueries).toContain('"Sam Smith" linkedin')
    // Only first 2 founders.
    expect(seenQueries).not.toContain('"Casey Lee" linkedin')
    expect(seenQueries.filter(q => q.includes('linkedin'))).toHaveLength(2)
  })

  it('skips founders with names ≤3 chars', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      founderNames: ['', 'JD', 'Jane Doe'],
    })
    expect(seenQueries).toContain('"Jane Doe" linkedin')
    expect(seenQueries).not.toContain('"" linkedin')
    expect(seenQueries).not.toContain('"JD" linkedin')
  })

  it('does NOT fire any company-name-prefixed queries', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'invoice processing for SMBs',
      industry: 'fintech',
      founderNames: ['Jane Doe'],
    })
    // Old name-prefixed queries are gone.
    expect(seenQueries.find(q => q.includes('"Acme"'))).toBeUndefined()
    expect(seenQueries.find(q => q.includes('Acme recent news'))).toBeUndefined()
    expect(seenQueries.find(q => q.includes('Acme funding round'))).toBeUndefined()
    expect(seenQueries.find(q => q.includes('Acme competitors'))).toBeUndefined()
    expect(seenQueries.find(q => q.includes('Acme founders background'))).toBeUndefined()
  })

  it('returns empty bundle when truly empty (no nicheSignal, no description, no industry, no founders)', async () => {
    mockGetCredential.mockReturnValue('test-key')
    let exaCalled = false
    setExaMockResponses({
      searchAndContents: async () => {
        exaCalled = true
        return { results: [] }
      },
    })
    const result = await searchCompanyContext({ companyName: 'Acme' })
    expect(result).toEqual({ queries: [], results: [] })
    expect(exaCalled).toBe(false)   // no queries built → no Exa call fired
  })

  it('orders queries: niche → industry → competitors → founder LinkedIn', async () => {
    mockGetCredential.mockReturnValue('test-key')
    const seenQueries: string[] = []
    setExaMockResponses({
      searchAndContents: async (query) => {
        seenQueries.push(query as string)
        return { results: [] }
      },
    })
    await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'invoice processing for SMBs',
      industry: 'fintech',
      founderNames: ['Jane Doe'],
    })
    expect(seenQueries).toEqual([
      'invoice processing for SMBs',
      'fintech market size 2025',
      'fintech competitors alternatives',
      '"Jane Doe" linkedin',
    ])
  })

  it('degrades silently when individual queries fail', async () => {
    mockGetCredential.mockReturnValue('test-key')
    let callCount = 0
    setExaMockResponses({
      searchAndContents: async () => {
        callCount += 1
        if (callCount <= 1) throw new Error('network')
        return { results: [{ url: 'https://e.com', text: 'snippet' }] }
      },
    })
    const result = await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'invoice processing for SMBs',
      industry: 'fintech',
    })
    // 3 queries fire (niche/industry/competitors); call #1 fails, calls #2 and
    // #3 each return 1 result → 2 results total.
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
    const result = await searchCompanyContext({
      companyName: 'Acme',
      nicheSignal: 'invoice processing for SMBs',
    })
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
