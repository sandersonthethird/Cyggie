import { tryGetExaClient } from './exa-client'
import { validateUrlForFetch } from '@main/security/url-allowlist'

/**
 * Exa-backed research utilities used by:
 *   1. memo-generator.ts / memo-producer-agent pre-research pass — searchCompanyContext()
 *   2. The thesis-stress-test agent and memo-producer agent's web_search and web_fetch tools
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  searchCompanyContext(input):                                   │
 *   │                                                                 │
 *   │    Four query categories (no company-name queries — pre-launch  │
 *   │    companies have no web presence under their name):            │
 *   │      1. Niche-similarity neural search (meeting-summary seed     │
 *   │         + themes) — surfaces adjacent companies / product pages │
 *   │      2. Industry market sizing — "{industry} market size 2025"  │
 *   │      3. Explicit competitors — "{description-snippet}           │
 *   │         competitors alternatives" (keyword-led; complements 1)  │
 *   │      4. Per-contact LinkedIn — when contact has linkedinUrl     │
 *   │         in CRM: exa.getContents([url]) direct fetch.            │
 *   │         When no URL: `"{name}" linkedin` search fallback.       │
 *   │                                                                 │
 *   │    All run in parallel; top-3 results per search query,         │
 *   │    ~1.5k chars/result; LinkedIn fetches ~8k chars/result.       │
 *   │    Aggregated into a single { queries[], results[] } object the │
 *   │    memo generator inlines under "## External Research" and the  │
 *   │    producer agent uses to populate its web_fetch allowlist.     │
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
  /** Used only in logs; the company name is NOT in any query (pre-launch companies have no web presence under their name). */
  companyName: string
  /** Niche-query fallback when nicheSignal is empty/stub. Also seeds the explicit competitors query. */
  companyDescription?: string | null
  primaryDomain?: string | null
  industry?: string | null
  themes?: string[] | null
  /**
   * Niche-similarity query seed. Caller should pass the most recent meeting
   * summary's content (truncated). Drives Exa neural search to find competitor
   * companies / product pages without requiring the company itself to be
   * discoverable.
   */
  nicheSignal?: string | null
  /** 0–2 founder full names. Each becomes a quoted `"{name}" linkedin` query. Used only when no `linkedinContacts` entry exists for the founder. */
  founderNames?: string[]
  /**
   * Contacts with stored LinkedIn URLs. Each becomes a direct `exa.getContents`
   * fetch (more precise than a text search for the founder's name). Producer
   * agent passes its top contacts; legacy memo generator does not.
   */
  linkedinContacts?: Array<{ name: string; url: string }>
}

/**
 * Internal query representation. The pre-research dispatcher handles both
 * shapes uniformly: 'search' uses exa.searchAndContents; 'fetch' uses
 * exa.getContents on a known URL.
 */
type PreQuery =
  | { kind: 'search'; query: string }
  | { kind: 'fetch'; url: string; label: string }

/** Per-result chars for direct LinkedIn fetches (full page vs. snippet). */
const PRE_RESEARCH_FETCH_CHARS = 8000

function makeTimeout<T>(ms: number, label: string): Promise<T> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  )
}

/**
 * Returns a Promise that rejects with AbortError when the signal aborts.
 * Used as a participant in `Promise.race` alongside Exa requests so a user
 * cancel propagates immediately. If `signal` is undefined, returns a
 * Promise that never settles (Promise.race ignores it).
 */
function signalRejector<T>(signal?: AbortSignal): Promise<T> {
  return new Promise<T>((_, reject) => {
    if (!signal) return
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      { once: true },
    )
  })
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
  signal?: AbortSignal,
): Promise<ExternalResearchBundle> {
  const exa = tryGetExaClient()
  if (!exa) return { queries: [], results: [] }

  const preQueries = buildPreResearchQueries(input)
  // Public `queries` field is the human-readable string form (search query
  // text, or `LinkedIn: {name}` label for direct fetches).
  const queries = preQueries.map((q) => (q.kind === 'search' ? q.query : q.label))
  const empty: ExternalResearchBundle = { queries, results: [] }

  const fetchQueryCount = preQueries.filter((q) => q.kind === 'fetch').length
  const searchQueryCount = preQueries.length - fetchQueryCount
  console.info('[exa-research] pre-research', {
    company: input.companyName,
    hasNiche: !!buildNicheQuery(input),
    hasIndustry: !!input.industry?.trim(),
    hasCompetitors: hasCompetitorsSeed(input),
    linkedinFetchCount: fetchQueryCount,
    founderSearchCount: searchQueryCount - (buildNicheQuery(input) ? 1 : 0) - (input.industry?.trim() ? 1 : 0) - (hasCompetitorsSeed(input) ? 1 : 0),
    queryCount: preQueries.length,
  })

  if (preQueries.length === 0) {
    console.info('[exa-research] empty pre-research — no seeds to query')
    return empty
  }

  // If the caller already aborted before we started, surface AbortError so
  // the IPC handler returns the structured aborted response.
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const dispatched = preQueries.map(async (q) => {
    try {
      if (q.kind === 'search') {
        const response = (await Promise.race([
          exa.searchAndContents(q.query, { numResults: PRE_RESEARCH_RESULTS_PER_QUERY }),
          makeTimeout(PRE_RESEARCH_TIMEOUT_MS, `Exa search "${q.query}"`),
          signalRejector<{ results?: never }>(signal),
        ])) as { results?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }> }
        const out: ExternalResearchResult[] = []
        for (const r of response.results ?? []) {
          if (!r.url) continue
          out.push({
            url: r.url,
            title: r.title ?? null,
            text: truncate(r.text, PRE_RESEARCH_RESULT_CHARS),
            publishedDate: r.publishedDate ?? null,
            query: q.query,
          })
        }
        return out
      }

      // q.kind === 'fetch' — direct exa.getContents on a known URL.
      // Validate URL shape first (https + no private IPs).
      const validation = await validateUrlForFetch(q.url)
      if (!validation.ok) {
        console.warn('[exa-research] linkedin fetch rejected:', q.url, validation.message)
        return []
      }
      const response = (await Promise.race([
        exa.getContents([q.url]),
        makeTimeout(PRE_RESEARCH_TIMEOUT_MS, `Exa fetch "${q.url}"`),
        signalRejector<{ results?: never }>(signal),
      ])) as { results?: Array<{ url?: string; title?: string; text?: string; publishedDate?: string }> }
      const first = response.results?.[0]
      if (!first?.text) return []
      return [{
        url: first.url ?? q.url,
        title: first.title ?? null,
        text: truncate(first.text, PRE_RESEARCH_FETCH_CHARS),
        publishedDate: first.publishedDate ?? null,
        query: q.label,
      }]
    } catch (err) {
      // Propagate cancellation; everything else degrades silently.
      if ((err as Error).name === 'AbortError') throw err
      const id = q.kind === 'search' ? q.query : q.url
      console.warn('[exa-research] pre-research query failed:', id, (err as Error).message)
      return []
    }
  })

  try {
    const allResults = await Promise.all(dispatched)
    return { queries, results: allResults.flat() }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    console.warn('[exa-research] pre-research aggregate failed:', (err as Error).message)
    return empty
  }
}

/**
 * Build the per-run query list. Four categories, all niche-/founder-targeted
 * (NOT company-name-targeted) so pre-launch companies with zero web presence
 * still get useful results:
 *
 *   1. Niche-similarity (Exa neural) — describes the SPACE, not the player
 *   2. Industry market sizing — broad, name-agnostic
 *   3. Explicit competitors — keyword-led, complements (1)
 *   4. Per-contact LinkedIn — direct fetch when URL known, search fallback otherwise
 *
 * Returns [] when nothing has enough seed data (truly empty company).
 */
function buildPreResearchQueries(input: SearchCompanyContextInput): PreQuery[] {
  const out: PreQuery[] = []

  // 1. Niche-similarity search.
  const niche = buildNicheQuery(input)
  if (niche) out.push({ kind: 'search', query: niche })

  // 2. Industry market sizing.
  if (input.industry?.trim()) {
    out.push({ kind: 'search', query: `${input.industry.trim()} market size 2025` })
  }

  // 3. Explicit competitors query — keyword-led, complements neural niche search.
  // Pre-launch companies still get useful results because we never use the
  // company name (only description/industry seeds).
  const competitorsSeed = buildCompetitorsSeed(input)
  if (competitorsSeed) {
    out.push({ kind: 'search', query: `${competitorsSeed} competitors alternatives` })
  }

  // 4a. Per-contact LinkedIn DIRECT FETCH (when URL stored on contact).
  // Skips a search hop; more accurate; populates the producer agent's
  // web_fetch allowlist via the result URL.
  const linkedinFetches = (input.linkedinContacts ?? [])
    .filter((c) => c.name?.trim().length > 3 && c.url?.trim())
    .slice(0, 4) // cap to avoid runaway when many contacts have URLs
  const fetchedNames = new Set(linkedinFetches.map((c) => c.name.trim().toLowerCase()))
  for (const c of linkedinFetches) {
    out.push({ kind: 'fetch', url: c.url.trim(), label: `LinkedIn: ${c.name.trim()}` })
  }

  // 4b. Per-founder LinkedIn SEARCH FALLBACK (when no URL was supplied).
  // Skip names already covered by a direct fetch (4a).
  const validFounderNames = (input.founderNames ?? [])
    .map((n) => n.trim())
    .filter((n) => n.length > 3 && !fetchedNames.has(n.toLowerCase()))
    .slice(0, 2)
  for (const name of validFounderNames) {
    out.push({ kind: 'search', query: `"${name}" linkedin` })
  }

  return out
}

function buildCompetitorsSeed(input: SearchCompanyContextInput): string | null {
  const desc = pickNonStub(input.companyDescription)
  if (desc) return desc.slice(0, 200)
  if (input.industry?.trim()) return input.industry.trim()
  return null
}

function hasCompetitorsSeed(input: SearchCompanyContextInput): boolean {
  return buildCompetitorsSeed(input) !== null
}

function buildNicheQuery(input: SearchCompanyContextInput): string | null {
  // Prefer meeting-derived niche signal (richest, fresh, founder's own words).
  // Fall back to company.description for companies without summaries yet.
  const niche =
    pickNonStub(input.nicheSignal) ??
    pickNonStub(input.companyDescription)
  if (!niche) return null
  // Augment with themes for vertical anchoring; harmless if empty.
  const themesPart = input.themes?.length ? ` (themes: ${input.themes.join(', ')})` : ''
  return niche + themesPart
}

function pickNonStub(s: string | null | undefined): string | null {
  const trimmed = s?.trim() ?? ''
  return trimmed.length >= 20 ? trimmed : null
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
