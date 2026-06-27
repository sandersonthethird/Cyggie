/**
 * T3 · Slice 0b — NO-BEHAVIOR-CHANGE proof for routing desktop's company name
 * resolution through the shared `resolveCompanyName` (packages/services
 * meeting-enrichment/name.ts).
 *
 * Exercises every tier of `enrichCompany`:
 *   0. authoritative org_companies lookup   1. legacy `companies` cache
 *   2. homepage parse (plausibility-gated)  3. LLM fallback (plausibility-gated)
 *   4. deterministic domain heuristic       + in-flight dedup
 * Captured on the PRE-rewire code; the rewire onto the shared resolver must
 * reproduce it. Tier 4 is asserted against the shared `domainToTitleCase` so the
 * expectation is stable across the refactor (the desktop copy was byte-identical).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { domainToTitleCase } from '@cyggie/db/meeting-enrichment/helpers'

// ── transport + LLM seams ────────────────────────────────────────────────────
const netFetch = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => netFetch(...args) } }))

const llmGenerate = vi.fn()
vi.mock('@cyggie/services/llm/provider-factory', () => ({
  getProvider: () => ({ generateSummary: (...args: unknown[]) => llmGenerate(...args) }),
}))

// ── repos (tiers 0/1 + the meeting write) ────────────────────────────────────
const getCanonical = vi.fn()
const cacheGet = vi.fn()
const cacheUpsert = vi.fn()
vi.mock('@cyggie/db/sqlite/repositories/company.repo', () => ({
  getByDomain: (...a: unknown[]) => cacheGet(...a),
  upsert: (...a: unknown[]) => cacheUpsert(...a),
  getByDomains: () => new Map(),
}))
vi.mock('@cyggie/db/sqlite/repositories', () => ({
  getCompanyCanonicalNameByDomain: (...a: unknown[]) => getCanonical(...a),
  getEntityTypeByNameOrDomain: () => null,
  updateMeeting: vi.fn(),
}))

const { enrichCompany } = await import('../main/services/company-enrichment')

/** A net.fetch result whose body is HTML fetchHomepage will accept. */
function htmlResponse(body: string) {
  return { ok: true, text: async () => body }
}

beforeEach(() => {
  netFetch.mockReset()
  llmGenerate.mockReset()
  getCanonical.mockReset()
  cacheGet.mockReset()
  cacheUpsert.mockReset()
  getCanonical.mockReturnValue(null)
  cacheGet.mockReturnValue(null)
})

describe('enrichCompany — tier parity', () => {
  it('tier 0 — authoritative org_companies name wins, warms the cache, skips fetch/LLM', async () => {
    getCanonical.mockReturnValue('Acme Corp')
    const name = await enrichCompany('acme.com')
    expect(name).toBe('Acme Corp')
    expect(cacheUpsert).toHaveBeenCalledWith('acme.com', 'Acme Corp')
    expect(netFetch).not.toHaveBeenCalled()
    expect(llmGenerate).not.toHaveBeenCalled()
  })

  it('tier 1 — legacy cache hit returns without fetch/LLM', async () => {
    cacheGet.mockReturnValue({ displayName: 'Cached Co' })
    const name = await enrichCompany('cached.com')
    expect(name).toBe('Cached Co')
    expect(netFetch).not.toHaveBeenCalled()
    expect(llmGenerate).not.toHaveBeenCalled()
  })

  it('tier 2 — homepage og:site_name parse (plausible) wins; caches it', async () => {
    netFetch.mockResolvedValue(
      htmlResponse('<html><head><meta property="og:site_name" content="Superlog"><title>Superlog | Home</title></head></html>'),
    )
    const name = await enrichCompany('superlog.com')
    expect(name).toBe('Superlog')
    expect(llmGenerate).not.toHaveBeenCalled()
    expect(cacheUpsert).toHaveBeenCalledWith('superlog.com', 'Superlog')
  })

  it('tier 2 → 3 — an implausible homepage tagline falls through to the LLM', async () => {
    netFetch.mockResolvedValue(
      htmlResponse('<html><head><title>Streamlining The Middle-Market Deal Landscape</title></head></html>'),
    )
    llmGenerate.mockResolvedValue('Bowley Capital')
    const name = await enrichCompany('bowley.com')
    expect(name).toBe('Bowley Capital')
    expect(llmGenerate).toHaveBeenCalledTimes(1)
  })

  it('tier 3 — LLM name used when the homepage yields nothing', async () => {
    netFetch.mockResolvedValue({ ok: false })
    llmGenerate.mockResolvedValue('"Stripe"') // wrapping quotes stripped by the resolver
    const name = await enrichCompany('stripe.com')
    expect(name).toBe('Stripe')
  })

  it('tier 4 — UNKNOWN/implausible LLM degrades to the deterministic heuristic', async () => {
    netFetch.mockResolvedValue({ ok: false })
    llmGenerate.mockResolvedValue('UNKNOWN')
    const name = await enrichCompany('caphub.com')
    expect(name).toBe(domainToTitleCase('caphub.com'))
    expect(cacheUpsert).toHaveBeenCalledWith('caphub.com', domainToTitleCase('caphub.com'))
  })

  it('tier 4 — fetch + LLM both unavailable still resolves via the heuristic', async () => {
    netFetch.mockRejectedValue(new Error('network down'))
    llmGenerate.mockRejectedValue(new Error('no key'))
    const name = await enrichCompany('widgetworks.com')
    expect(name).toBe(domainToTitleCase('widgetworks.com'))
  })

  it('in-flight dedup — concurrent callers for one domain share a single resolution', async () => {
    netFetch.mockResolvedValue(
      htmlResponse('<html><head><meta property="og:site_name" content="Dedup Inc"><title>x</title></head></html>'),
    )
    const [a, b] = await Promise.all([enrichCompany('dedup.com'), enrichCompany('dedup.com')])
    expect(a).toBe('Dedup Inc')
    expect(b).toBe('Dedup Inc')
    expect(netFetch).toHaveBeenCalledTimes(1)
  })
})
