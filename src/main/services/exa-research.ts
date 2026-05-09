import { tryGetExaClient } from './exa-client'
import { validateUrlForFetch } from '../security/url-allowlist'

/**
 * Exa-backed research utilities used by:
 *   1. memo-generator.ts pre-research pass — searchCompanyContext()
 *   2. The thesis-stress-test agent's web_search and web_fetch tools
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  searchCompanyContext(input):                                   │
 *   │                                                                 │
 *   │    For company "Acme" in industry "fintech" with themes [...]:  │
 *   │      query "Acme fintech recent news"                           │
 *   │      query "Acme funding round"                                 │
 *   │      query "fintech market size 2025"                           │
 *   │      query "Acme competitors"                                   │
 *   │      query "Acme founders background"                           │
 *   │                                                                 │
 *   │    All run in parallel, top-3 results each, ~1.5k chars/result. │
 *   │    Aggregated into a single { queries[], results[] } object the │
 *   │    memo-generator inlines under "## External Research".          │
 *   │                                                                 │
 *   │    NEVER throws. Returns an empty bundle if Exa is not          │
 *   │    configured or any network failure occurs. Memo gen must      │
 *   │    keep working without external research.                      │
 *   └────────────────────────────────────────────────────────────────┘
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  webSearch / webFetch (agent tools):                            │
 *   │                                                                 │
 *   │    webSearch(query)                                              │
 *   │      → exa.searchAndContents(query, {numResults: 5})            │
 *   │      → top 5, each text truncated to ~1500 chars                │
 *   │                                                                 │
 *   │    webFetch(url)                                                 │
 *   │      → validateUrlForFetch(url)  ← https + private-IP block      │
 *   │      → exa.getContents([url])                                       │
 *   │      → text truncated to ~8000 chars                             │
 *   │                                                                 │
 *   │    Throws or returns {error} envelope so the agent loop can     │
 *   │    surface failures into tool_result blocks.                    │
 *   └────────────────────────────────────────────────────────────────┘
 */

const PRE_RESEARCH_TIMEOUT_MS = 12_000
const PRE_RESEARCH_RESULT_CHARS = 1500
const PRE_RESEARCH_RESULTS_PER_QUERY = 3

const WEB_SEARCH_RESULT_CHARS = 1500
const WEB_SEARCH_RESULTS_PER_QUERY = 5
const WEB_FETCH_CHARS = 8000

export interface ExternalResearchResult {
  url: string
  title: string | null
  text: string
  publishedDate: string | null
  query: string
}

export interface ExternalResearchBundle {
  queries: string[]
  results: ExternalResearchResult[]
}

interface SearchCompanyContextInput {
  companyName: string
  primaryDomain?: string | null
  industry?: string | null
  themes?: string[] | null
}

function makeTimeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  )
}

function truncate(s: string | undefined | null, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max) + '\n\n[…truncated]'
}

/**
 * Pre-research pass for memo-generator. Best-effort: any failure (no Exa key,
 * Exa down, all queries timeout) returns an empty bundle. The memo generator
 * proceeds with whatever internal data it has.
 */
export async function searchCompanyContext(
  input: SearchCompanyContextInput,
): Promise<ExternalResearchBundle> {
  const exa = tryGetExaClient()
  if (!exa) return { queries: [], results: [] }

  const queries = buildPreResearchQueries(input)
  const empty: ExternalResearchBundle = { queries, results: [] }

  const fetches = queries.map(async query => {
    try {
      const response = (await Promise.race([
        exa.searchAndContents(query, {
          numResults: PRE_RESEARCH_RESULTS_PER_QUERY,
        }),
        makeTimeout(PRE_RESEARCH_TIMEOUT_MS, `Exa search "${query}"`),
      ])) as { results?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }> }
      const out: ExternalResearchResult[] = []
      for (const r of response.results ?? []) {
        if (!r.url) continue
        out.push({
          url: r.url,
          title: r.title ?? null,
          text: truncate(r.text, PRE_RESEARCH_RESULT_CHARS),
          publishedDate: r.publishedDate ?? null,
          query,
        })
      }
      return out
    } catch (err) {
      console.warn('[exa-research] pre-research query failed:', query, (err as Error).message)
      return []
    }
  })

  try {
    const allResults = await Promise.all(fetches)
    return { queries, results: allResults.flat() }
  } catch (err) {
    console.warn('[exa-research] pre-research aggregate failed:', (err as Error).message)
    return empty
  }
}

function buildPreResearchQueries(input: SearchCompanyContextInput): string[] {
  const name = input.companyName.trim()
  if (!name) return []
  const queries: string[] = [
    `"${name}" recent news`,
    `"${name}" funding round`,
    `"${name}" competitors`,
    `"${name}" founders background`,
  ]
  if (input.industry) {
    queries.push(`${input.industry} market size 2025`)
  }
  return queries
}

// ─── Agent tools ──────────────────────────────────────────────────────────

export interface AgentWebSearchResult {
  url: string
  title: string | null
  snippet: string
  publishedDate: string | null
}

export interface AgentWebSearchOutput {
  query: string
  results: AgentWebSearchResult[]
}

export interface AgentWebSearchError {
  error: string
}

/**
 * Agent's web_search tool. Returns top-N results with truncated snippets.
 * Distinct from searchCompanyContext: this is invoked by the model on demand
 * with arbitrary queries, not the fixed-template pre-research.
 */
export async function agentWebSearch(query: string): Promise<AgentWebSearchOutput | AgentWebSearchError> {
  const exa = tryGetExaClient()
  if (!exa) return { error: 'Exa API key not configured' }
  try {
    const response = (await Promise.race([
      exa.searchAndContents(query, { numResults: WEB_SEARCH_RESULTS_PER_QUERY }),
      makeTimeout(PRE_RESEARCH_TIMEOUT_MS, `Exa web_search "${query}"`),
    ])) as { results?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }> }
    const results: AgentWebSearchResult[] = []
    for (const r of response.results ?? []) {
      if (!r.url) continue
      results.push({
        url: r.url,
        title: r.title ?? null,
        snippet: truncate(r.text, WEB_SEARCH_RESULT_CHARS),
        publishedDate: r.publishedDate ?? null,
      })
    }
    return { query, results }
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 401) return { error: 'Exa authentication failed (401)' }
    if (status === 429) return { error: 'Exa rate limited (429)' }
    return { error: `web_search failed: ${(err as Error).message}` }
  }
}

export interface AgentWebFetchOutput {
  url: string
  title: string | null
  text: string
  truncated: boolean
}

export interface AgentWebFetchError {
  error: string
  rejectionCode?: string
}

/**
 * Agent's web_fetch tool. Validates URL via url-allowlist before hitting Exa.
 * Returns the page's extracted text, truncated to WEB_FETCH_CHARS.
 */
export async function agentWebFetch(url: string): Promise<AgentWebFetchOutput | AgentWebFetchError> {
  const validation = await validateUrlForFetch(url)
  if (!validation.ok) {
    return { error: validation.message, rejectionCode: validation.code }
  }
  const exa = tryGetExaClient()
  if (!exa) return { error: 'Exa API key not configured' }
  try {
    const response = (await Promise.race([
      exa.getContents([url]),
      makeTimeout(PRE_RESEARCH_TIMEOUT_MS, `Exa web_fetch "${url}"`),
    ])) as { results?: Array<{ url?: string; title?: string; text?: string }> }
    const first = response.results?.[0]
    if (!first || !first.text) {
      return { error: 'web_fetch returned no extractable text' }
    }
    const truncated = first.text.length > WEB_FETCH_CHARS
    return {
      url: first.url ?? url,
      title: first.title ?? null,
      text: truncate(first.text, WEB_FETCH_CHARS),
      truncated,
    }
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    if (status === 401) return { error: 'Exa authentication failed (401)' }
    if (status === 429) return { error: 'Exa rate limited (429)' }
    return { error: `web_fetch failed: ${(err as Error).message}` }
  }
}
