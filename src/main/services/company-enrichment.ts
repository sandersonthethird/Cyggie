import { net } from 'electron'
import { getProvider } from '@cyggie/services/llm/provider-factory'
import * as companyCacheRepo from '@cyggie/db/sqlite/repositories/company.repo'
import * as orgCompanyRepo from '@cyggie/db/sqlite/repositories'
import * as meetingRepo from '@cyggie/db/sqlite/repositories'
import { extractDomainFromEmail, extractDomainsFromEmails, humanizeDomainName } from '../utils/company-extractor'
import type { CompanySuggestion } from '../../shared/types/meeting'
import type { CalendarEvent } from '../../shared/types/calendar'

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

  // 2. Tier 1: Fetch homepage HTML and parse. Reject taglines/slogans that a
  //    site puts in its <title>/og:site_name (e.g. "Streamlining The
  //    Middle-Market Deal Landscape") — those are marketing copy, not names.
  const html = await fetchHomepage(domain)
  const parsed = html ? parseCompanyName(html) : null
  let displayName = parsed && isPlausibleCompanyName(parsed) ? parsed : null

  // 3. Tier 2: Claude fallback if website didn't yield a usable name. Also
  //    gated — the LLM tends to answer "what does this company do" with a
  //    descriptive phrase rather than the actual name.
  if (!displayName) {
    const llm = await resolveViaLLM(domain)
    displayName = llm && isPlausibleCompanyName(llm) ? llm : null
  }

  // 4. Last resort: deterministic domain heuristic. Preferred over an
  //    unverified guess — "caphub.com" → "Cap Hub" is a worse label but never
  //    a hallucinated tagline, and the user can correct the casing in one place.
  if (!displayName) {
    displayName = domainToTitleCase(domain)
  }

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

function parseCompanyName(html: string): string | null {
  // Priority 1: og:site_name
  const ogSiteName =
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1]
  if (ogSiteName && ogSiteName.trim().length >= 2) {
    return ogSiteName.trim()
  }

  // Priority 2: application-name
  const appName =
    html.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']application-name["']/i)?.[1]
  if (appName && appName.trim().length >= 2) {
    return appName.trim()
  }

  // Priority 3: <title> tag (cleaned)
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (titleMatch) {
    const cleaned = cleanTitle(titleMatch[1].trim())
    if (cleaned && cleaned.length >= 2 && cleaned.length <= 60) {
      return cleaned
    }
  }

  return null
}

function cleanTitle(title: string): string {
  return (
    title
      // Strip common suffixes: " | Home", " - Welcome", " :: About", " — Official Site"
      .replace(/\s*[|–—:·•]\s*.+$/, '')
      // Strip common prefixes: "Home - ", "Welcome to "
      .replace(/^(Home|Welcome to)\s*[-–—|:]\s*/i, '')
      .trim()
  )
}

async function resolveViaLLM(domain: string): Promise<string | null> {
  try {
    const provider = getProvider('enrichment')
    const raw = (
      await provider.generateSummary(
        'You identify a company by its official brand name only.',
        `What is the official company/brand name of the business at the domain "${domain}"?\n\n` +
        `Rules:\n` +
        `- Reply with ONLY the short brand name (e.g. "Stripe", "CapHub", "Andreessen Horowitz").\n` +
        `- Do NOT reply with a tagline, slogan, or description of what the company does.\n` +
        `- If you are not confident of the real name, reply with exactly: UNKNOWN`
      )
    ).trim()
    // Strip wrapping quotes/punctuation the model sometimes adds.
    const name = raw.replace(/^["'“”]+|["'“”.]+$/g, '').trim()
    if (name.toUpperCase() === 'UNKNOWN') return null
    if (name.length >= 2 && name.length <= 100 && !name.includes('\n')) {
      return name
    }
  } catch (err) {
    console.error(`LLM company resolution failed for ${domain}:`, err)
  }

  return null
}

/**
 * Reject strings that look like a marketing tagline/slogan/sentence rather than
 * a company name. High-precision: it must not reject real names (which can be
 * long, e.g. "Bank of America Merrill Lynch"), only obvious value-prop copy
 * (e.g. "Streamlining The Middle-Market Deal Landscape", "Helping Independent
 * Sponsors Maximize Every Opportunity"). When in doubt we keep the candidate —
 * the deterministic domain heuristic is the safety net upstream.
 */
export function isPlausibleCompanyName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 2 || trimmed.length > 60) return false
  // A trailing period reads as a sentence, not a name.
  if (/[.!?]$/.test(trimmed)) return false
  const words = trimmed.split(/\s+/)
  // Real company names are short; taglines run long.
  if (words.length > 7) return false
  // Slogans almost always open with a gerund ("Streamlining…", "Helping…",
  // "Empowering…") and then keep going. A real name effectively never does.
  if (words.length >= 3 && /^[A-Za-z]+ing$/.test(words[0])) return false
  return true
}

function domainToTitleCase(domain: string): string {
  return humanizeDomainName(domain.split('.')[0])
}
