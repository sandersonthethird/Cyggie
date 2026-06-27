import { net } from 'electron'
import { getProvider } from '@cyggie/services/llm/provider-factory'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import { resolveCompanyName } from '@cyggie/services/meeting-enrichment/name'
import { domainToTitleCase, isPlausibleCompanyName } from '@cyggie/db/meeting-enrichment/helpers'
import * as companyCacheRepo from '@cyggie/db/sqlite/repositories/company.repo'
import * as orgCompanyRepo from '@cyggie/db/sqlite/repositories'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import { extractDomainFromEmail, extractDomainsFromEmails } from '../utils/company-extractor'
import type { CompanySuggestion } from '../../shared/types/meeting'
import type { CalendarEvent } from '../../shared/types/calendar'

// The homepage-parse → LLM → heuristic tiers now live in the shared, I/O-injected
// resolveCompanyName (packages/services meeting-enrichment/name.ts), so desktop +
// gateway resolve names identically. isPlausibleCompanyName / domainToTitleCase moved
// to @cyggie/db helpers; re-export the former so existing importers keep working.
export { isPlausibleCompanyName }

function getPersistedEntityType(
  companyName: string,
  domain: string | null
): CompanySuggestion['entityType'] {
  return orgCompanyRepo.getEntityTypeByNameOrDomain(companyName, domain) || null
}

// In-flight dedup: concurrent callers for the same domain share one network/LLM
// roundtrip. Without this, the post-deploy reconcile burst (Step 5 in
// "i had a meeting" plan) could fire N parallel enrichments for the same
// domain across N meetings before the cache row is written.
const enrichInFlight = new Map<string, Promise<string>>()

// Lazy LLM seam for resolveCompanyName: getProvider('enrichment') THROWS when no
// API key is configured, so it must only run when the LLM tier actually fires and
// inside resolveCompanyName's try/catch (which degrades to the heuristic). Building
// the provider per-call defers construction to that point — matching desktop's
// previous "getProvider inside resolveViaLLM" behavior exactly; a homepage-tier hit
// never touches it.
const enrichmentLlm: LLMProvider = {
  name: 'enrichment',
  isAvailable: () => getProvider('enrichment').isAvailable(),
  generateSummary: (...args) => getProvider('enrichment').generateSummary(...args),
  streamWithThinking: (...args) => getProvider('enrichment').streamWithThinking(...args),
}

/**
 * Enrich a single domain: resolve its true company name via website fetch + LLM fallback.
 * Returns the display name and caches it.
 *
 * Lookup precedence:
 *   1. org_companies (authoritative — checks primary_domain + domain aliases).
 *      If a real company is associated with this domain, its canonical_name
 *      wins. The legacy cache row (which can be stale after merges or renames)
 *      is rewritten to match so subsequent fast-path cache hits are correct.
 *   2. legacy `companies` cache (lazy domain → name lookup).
 *   3. website parse → LLM → domain heuristic (the slow path that populates
 *      the cache for first-time domains).
 */
export async function enrichCompany(domain: string): Promise<string> {
  const existing = enrichInFlight.get(domain)
  if (existing) return existing

  const promise = enrichCompanyInner(domain).finally(() => {
    enrichInFlight.delete(domain)
  })
  enrichInFlight.set(domain, promise)
  return promise
}

async function enrichCompanyInner(domain: string): Promise<string> {
  // 0. Authoritative org_companies lookup — supersedes any cache value.
  const canonicalName = orgCompanyRepo.getCompanyCanonicalNameByDomain(domain)
  if (canonicalName) {
    // Keep the cache warm so the next sync caller (e.g. UI suggestions)
    // returns the same name without re-doing the join.
    companyCacheRepo.upsert(domain, canonicalName)
    return canonicalName
  }

  // 1. Check cache
  const cached = companyCacheRepo.getByDomain(domain)
  if (cached) return cached.displayName

  // 2-4. Tiers 2-4 (homepage parse → LLM → deterministic heuristic) run through the
  //      shared resolver so desktop + gateway resolve identically. fetchHomepage is
  //      the Electron transport; the LLM is the lazy enrichment adapter. Always
  //      returns a non-empty name (heuristic never fails).
  const displayName = await resolveCompanyName(domain, {
    fetchHtml: fetchHomepage,
    llm: enrichmentLlm,
  })

  // 5. Cache result
  companyCacheRepo.upsert(domain, displayName)
  return displayName
}

/**
 * Enrich all companies for a meeting based on its attendee emails.
 * Non-blocking — call with .catch() to fire-and-forget.
 */
export async function enrichCompaniesForMeeting(
  meetingId: string,
  emails: string[]
): Promise<void> {
  const domains = extractDomainsFromEmails(emails)
  if (domains.length === 0) return

  // Enrich each domain (sequentially to be polite to websites)
  const companies: CompanySuggestion[] = []
  for (const domain of domains) {
    try {
      const name = await enrichCompany(domain)
      companies.push({ name, domain })
    } catch (err) {
      console.error(`Failed to enrich domain ${domain}:`, err)
      // Use heuristic as fallback
      companies.push({ name: domainToTitleCase(domain), domain })
    }
  }

  // Update the meeting's companies column with enriched names
  const companyNames = companies.map((c) => c.name)
  meetingRepo.updateMeeting(meetingId, { companies: companyNames })
}

/**
 * Get enriched company suggestions for a list of emails.
 * Uses org_companies (authoritative) first, then the legacy cache, then a
 * domain heuristic. Synchronous — does not trigger website/LLM enrichment.
 */
export function getCompanySuggestionsFromEmails(emails: string[]): CompanySuggestion[] {
  const domains = extractDomainsFromEmails(emails)
  if (domains.length === 0) return []

  const cached = companyCacheRepo.getByDomains(domains)
  const suggestions: CompanySuggestion[] = []

  for (const domain of domains) {
    // Prefer the authoritative org_companies name (covers post-merge and
    // post-rename cases where the legacy cache could be stale). Falls back
    // to the cache, then to a domain heuristic.
    const name = orgCompanyRepo.getCompanyCanonicalNameByDomain(domain)
      ?? cached.get(domain)
      ?? domainToTitleCase(domain)

    suggestions.push({
      name,
      domain,
      entityType: getPersistedEntityType(name, domain)
    })
  }

  return suggestions
}

/**
 * Get enriched CompanySuggestion[] for a meeting's attendee_emails and companies columns.
 */
export function getCompanySuggestionsForMeeting(
  attendeeEmails: string[] | null,
  companiesRaw: string[] | null
): CompanySuggestion[] {
  if (attendeeEmails && attendeeEmails.length > 0) {
    return getCompanySuggestionsFromEmails(attendeeEmails)
  }

  // Fallback: if we have company names but no emails, return names without domains
  if (companiesRaw && companiesRaw.length > 0) {
    return companiesRaw.map((name) => ({
      name,
      domain: '',
      entityType: getPersistedEntityType(name, null)
    }))
  }

  return []
}

/**
 * Enrich all unique domains from calendar events.
 * Skips already-cached domains. Non-blocking — call with .catch() to fire-and-forget.
 */
export async function enrichDomainsFromCalendarEvents(events: CalendarEvent[]): Promise<void> {
  // Collect all unique domains across all events
  const allDomains = new Set<string>()
  for (const event of events) {
    if (event.attendeeEmails) {
      for (const email of event.attendeeEmails) {
        const domain = extractDomainFromEmail(email)
        if (domain) allDomains.add(domain)
      }
    }
  }

  if (allDomains.size === 0) return

  // Filter out already-cached domains
  const cached = companyCacheRepo.getByDomains([...allDomains])
  const uncached = [...allDomains].filter((d) => !cached.has(d))

  if (uncached.length === 0) return

  console.log(`[Company Enrichment] Enriching ${uncached.length} new domains from calendar events`)

  // Enrich sequentially to be polite to websites
  for (const domain of uncached) {
    try {
      await enrichCompany(domain)
    } catch (err) {
      console.error(`[Company Enrichment] Failed to enrich ${domain}:`, err)
    }
  }
}

// --- Internal helpers ---

async function fetchHomepage(domain: string): Promise<string | null> {
  for (const prefix of [`https://${domain}`, `https://www.${domain}`]) {
    try {
      const response = await net.fetch(prefix, {
        signal: AbortSignal.timeout(5000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Cyggie/1.0)',
          Accept: 'text/html'
        }
      })
      if (response.ok) {
        const text = await response.text()
        // Only return if it looks like HTML
        if (text.includes('<') && (text.includes('<title') || text.includes('<meta'))) {
          return text.slice(0, 50000) // Limit to first 50KB
        }
      }
    } catch {
      // Try next prefix
    }
  }
  return null
}
