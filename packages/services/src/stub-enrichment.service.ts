/**
 * Stub-enrichment service — Phase 4 of the investor-chips feature.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ FIND-OR-CREATE creates a stub                                  │
 *   │              ↓                                                 │
 *   │ queueStubEnrichment(companyId)                                  │
 *   │   - dedupe via in-flight set                                    │
 *   │   - throttle via concurrency cap (MAX_CONCURRENT)               │
 *   │              ↓                                                 │
 *   │ enrichStubCompany(companyId)                                    │
 *   │   1. re-fetch company; bail if no longer a stub                 │
 *   │   2. ask LLM for { entity_type, primary_domain, description }   │
 *   │   3. parse + validate response                                  │
 *   │   4. write back via updateCompany (only fields the LLM filled)  │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Failure modes:
 *   - LLM unavailable / no API key → log + skip; stub stays sparse.
 *   - LLM returns malformed JSON → log + skip.
 *   - LLM returns null fields → leave them untouched (no clobbering).
 *   - Company no longer exists / is no longer a stub → bail silently.
 *
 * NOT in scope:
 *   - Web lookup of domain (the LLM is asked to suggest one based on its training).
 *   - Background queue persistence (in-memory only; lost on app restart).
 *   - User-facing notification of completion (the cell will refetch on next render).
 */
import { getCompany, updateCompany } from '@cyggie/db/sqlite/repositories'
import { getProvider } from '@cyggie/services/llm/provider-factory'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import type { CompanyEntityType } from '@shared/types/company'

const MAX_CONCURRENT = 3
const inFlight = new Set<string>()
let activeCount = 0
const waiters: Array<() => void> = []

function acquire(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      activeCount++
      resolve()
    })
  })
}

function release(): void {
  activeCount--
  const next = waiters.shift()
  if (next) next()
}

const VALID_ENTITY_TYPES: ReadonlyArray<CompanyEntityType> = [
  'prospect', 'portfolio', 'vc_fund', 'pass', 'customer',
  'partner', 'vendor', 'lp', 'other', 'unknown',
] as const

const SYSTEM_PROMPT = `You are a venture-capital domain expert. Given the name of a company that has been added as an investor in a portfolio company tracker, you must identify what kind of investor it is and provide minimal verified metadata.

Return ONLY a JSON object with these fields (use null when unknown — never guess):
- entity_type: one of "vc_fund", "lp", "customer", "partner", "vendor", "other", or null
- primary_domain: the canonical website domain (e.g. "sequoiacap.com") without protocol, without "www.", or null if unsure
- description: a single short sentence (≤ 120 chars) describing the firm, or null

Strict rules:
- If the name is generic, ambiguous, or unknown to you, return all nulls.
- Never invent a domain. Only return one if you are confident.
- Never include trailing punctuation in the domain.
- Never wrap your response in markdown fences.`

interface LLMStubProposal {
  entity_type: CompanyEntityType | null
  primary_domain: string | null
  description: string | null
}

function parseProposal(raw: string): LLMStubProposal | null {
  try {
    // Strip any markdown fences the LLM may have added despite the system prompt.
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const parsed = JSON.parse(cleaned)
    if (!parsed || typeof parsed !== 'object') return null

    const et = parsed.entity_type
    const dom = parsed.primary_domain
    const desc = parsed.description

    return {
      entity_type:
        typeof et === 'string' && (VALID_ENTITY_TYPES as readonly string[]).includes(et)
          ? (et as CompanyEntityType)
          : null,
      primary_domain:
        typeof dom === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(dom.trim())
          ? dom.trim().toLowerCase().replace(/^www\./, '')
          : null,
      description:
        typeof desc === 'string' && desc.trim().length > 0 && desc.trim().length <= 200
          ? desc.trim()
          : null,
    }
  } catch (err) {
    console.error('[stub-enrichment] failed to parse LLM response:', err, 'raw:', raw.slice(0, 200))
    return null
  }
}

/**
 * Run LLM enrichment on a single stub company. Internal — call via queueStubEnrichment.
 *
 * Optional `provider` override is used by tests. Production path uses getProvider().
 */
export async function enrichStubCompany(
  companyId: string,
  providerOverride?: LLMProvider,
): Promise<void> {
  const company = getCompany(companyId)
  if (!company) return

  // Re-check stub criteria; the user may have manually filled in fields between
  // queueing and execution.
  const isStillStub =
    company.entityType === 'unknown' &&
    !company.primaryDomain &&
    !company.description
  if (!isStillStub) return

  let provider: LLMProvider
  try {
    provider = providerOverride ?? getProvider('enrichment')
  } catch (err) {
    // No API key configured — silently skip; user will see the stub stay sparse.
    console.warn('[stub-enrichment] no LLM provider available:', String(err))
    return
  }

  let raw: string
  try {
    raw = await provider.generateSummary(SYSTEM_PROMPT, company.canonicalName)
  } catch (err) {
    console.error('[stub-enrichment] LLM call failed for', company.canonicalName, err)
    return
  }

  const proposal = parseProposal(raw)
  if (!proposal) return

  // Build the patch: only include fields the LLM populated.
  const patch: Record<string, unknown> = {}
  if (proposal.entity_type) patch.entityType = proposal.entity_type
  if (proposal.primary_domain) patch.primaryDomain = proposal.primary_domain
  if (proposal.description) patch.description = proposal.description

  if (Object.keys(patch).length === 0) return

  try {
    updateCompany(companyId, patch, null)
    console.log('[stub-enrichment] enriched', company.canonicalName, '→', Object.keys(patch).join(', '))
  } catch (err) {
    console.error('[stub-enrichment] updateCompany failed for', companyId, err)
  }
}

/**
 * Queue a stub for enrichment. Fire-and-forget — never throws to the caller.
 *
 * Dedupe: a second call for the same companyId while one is in-flight is a no-op.
 * Throttle: at most MAX_CONCURRENT enrichments run at once; the rest wait FIFO.
 */
export function queueStubEnrichment(companyId: string): void {
  if (inFlight.has(companyId)) return
  inFlight.add(companyId)

  acquire()
    .then(() => enrichStubCompany(companyId))
    .catch((err) => console.error('[stub-enrichment] unexpected error:', err))
    .finally(() => {
      inFlight.delete(companyId)
      release()
    })
}

// ── Test-only helpers ────────────────────────────────────────────────────
export function _resetStubEnrichmentForTests(): void {
  inFlight.clear()
  activeCount = 0
  waiters.length = 0
}

export function _isInFlight(companyId: string): boolean {
  return inFlight.has(companyId)
}
