import { net } from 'electron'
import Anthropic from '@anthropic-ai/sdk'
import { getCredential } from '../security/credentials'
import * as companyCacheRepo from '../database/repositories/company.repo'
import * as orgCompanyRepo from '../database/repositories/org-company.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { extractDomainFromEmail, extractDomainsFromEmails, humanizeDomainName } from '../utils/company-extractor'
import type { CompanySuggestion } from '../../shared/types/meeting'
import type { CalendarEvent } from '../../shared/types/calendar'

function getPersistedEntityType(
  companyName: string,
  domain: string | null
): CompanySuggestion['entityType'] {
  return orgCompanyRepo.getEntityTypeByNameOrDomain(companyName, domain) || null
}

/**
 * Enrich a single domain: resolve its true company name via website fetch + LLM fallback.
 * Returns the display name and caches it.
 */
export async function enrichCompany(domain: string): Promise<string> {
  // 1. Check cache
  const cached = companyCacheRepo.getByDomain(domain)
  if (cached) return cached.displayName

  // 2. Tier 1: Fetch homepage HTML and parse
  const html = await fetchHomepage(domain)
  let displayName = html ? parseCompanyName(html) : null

  // 3. Tier 2: Claude fallback if website didn't yield a name
  if (!displayName) {
    displayName = await resolveViaLLM(domain)
  }

  // 4. Last resort: domain heuristic
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
 * Uses cache for instant results, does not trigger enrichment.
 */
export function getCompanySuggestionsFromEmails(emails: string[]): CompanySuggestion[] {
  const domains = extractDomainsFromEmails(emails)
  if (domains.length === 0) return []

  const cached = companyCacheRepo.getByDomains(domains)
  const suggestions: CompanySuggestion[] = []

  for (const domain of domains) {
    const name = cached.get(domain) || domainToTitleCase(domain)
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
  const apiKey = getCredential('claudeApiKey')
  if (!apiKey) return null

  try {
    const client = new Anthropic({ apiKey })
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: `What company operates the website domain "${domain}"? Reply with only the company name, nothing else.`
        }
      ]
    })

    const block = message.content[0]
    if (block.type === 'text') {
      const name = block.text.trim()
      // Sanity check: should be a reasonable company name
      if (name.length >= 2 && name.length <= 100 && !name.includes('\n')) {
        return name
      }
    }
  } catch (err) {
    console.error(`LLM company resolution failed for ${domain}:`, err)
  }

  return null
}

function domainToTitleCase(domain: string): string {
  return humanizeDomainName(domain.split('.')[0])
}
