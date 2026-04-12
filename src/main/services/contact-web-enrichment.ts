import { net } from 'electron'
import { getProvider } from '../llm/provider-factory'
import type {
  ContactDetail,
  ContactEnrichmentResult,
  ContactEnrichmentOptions
} from '../../shared/types/contact'
import * as contactRepo from '../database/repositories/contact.repo'
import * as companyRepo from '../database/repositories/org-company.repo'
import { enrichCompany } from './company-enrichment'
import { extractDomainFromEmail, humanizeDomainName } from '../utils/company-extractor'
import { normalizeLinkedinUrl } from '../database/repositories/contact-utils'

const LINKEDIN_URL_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s<>"')]+/gi
const TITLE_HINT_RE = /\b(ceo|cto|cfo|coo|chief|founder|co-founder|partner|principal|associate|director|manager|vice president|vp|head|lead|president)\b/i

interface PageSnapshot {
  url: string
  html: string
  text: string
}

interface WebContactGuess {
  title: string | null
  linkedinUrl: string | null
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractLinkedinUrlsFromHtml(html: string): string[] {
  const matches = html.match(LINKEDIN_URL_RE) || []
  const deduped = new Set<string>()
  for (const match of matches) {
    const normalized = normalizeLinkedinUrl(match)
    if (normalized) deduped.add(normalized)
  }
  return [...deduped]
}

function pickBestLinkedinUrl(contact: ContactDetail, urls: string[]): string | null {
  if (!urls.length) return null
  const first = (contact.firstName || '').trim().toLowerCase()
  const last = (contact.lastName || '').trim().toLowerCase()
  const full = contact.fullName.trim().toLowerCase().replace(/\s+/g, '-')

  const ranked = [...urls].sort((a, b) => {
    const aIn = /\/in\//i.test(a) ? 1 : 0
    const bIn = /\/in\//i.test(b) ? 1 : 0
    if (aIn !== bIn) return bIn - aIn
    return a.length - b.length
  })

  const targeted = ranked.find((url) => {
    const normalized = url.toLowerCase()
    if (!/\/in\//i.test(normalized)) return false
    if (first && !normalized.includes(first)) return false
    if (last && !normalized.includes(last)) return false
    return true
  })
  if (targeted) return targeted

  const slugHit = ranked.find((url) => {
    if (!/\/in\//i.test(url)) return false
    const lower = url.toLowerCase()
    return full && lower.includes(full)
  })
  if (slugHit) return slugHit

  // Only return a URL if it's a personal profile (/in/) — never return a /company/ page
  const anyPersonalProfile = ranked.find((url) => /\/in\//i.test(url))
  return anyPersonalProfile || null
}

function inferTitleFromPages(contact: ContactDetail, pages: PageSnapshot[]): string | null {
  const fullName = contact.fullName.trim()
  if (!fullName) return null
  const fullNameRe = escapeRegex(fullName)

  for (const page of pages) {
    const jobTitleJsonMatch = page.html.match(/"jobTitle"\s*:\s*"([^"]{2,90})"/i)
    if (jobTitleJsonMatch?.[1]) {
      const jobTitle = jobTitleJsonMatch[1].trim()
      if (TITLE_HINT_RE.test(jobTitle)) return jobTitle
    }

    const forward = new RegExp(
      `${fullNameRe}\\s*[-|,:]\\s*([A-Z][A-Za-z0-9/&().,' -]{2,90})`,
      'i'
    )
    const forwardMatch = page.text.match(forward)
    if (forwardMatch?.[1]) {
      const candidate = forwardMatch[1].trim()
      if (TITLE_HINT_RE.test(candidate)) return candidate
    }

    const reverse = new RegExp(
      `([A-Z][A-Za-z0-9/&().,' -]{2,90})\\s*[-|,:]\\s*${fullNameRe}`,
      'i'
    )
    const reverseMatch = page.text.match(reverse)
    if (reverseMatch?.[1]) {
      const candidate = reverseMatch[1].trim()
      if (TITLE_HINT_RE.test(candidate)) return candidate
    }
  }

  return null
}

function inferDomain(contact: ContactDetail): string | null {
  const companyDomain = (contact.primaryCompany?.primaryDomain || '').trim().toLowerCase()
  if (companyDomain) return companyDomain.replace(/^www\./, '')

  for (const email of contact.emails || []) {
    const domain = extractDomainFromEmail(email)
    if (domain) return domain.replace(/^www\./, '')
  }
  return null
}

async function fetchPageSnapshot(url: string): Promise<PageSnapshot | null> {
  try {
    const response = await net.fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Cyggie/1.0)',
        Accept: 'text/html'
      }
    })
    if (!response.ok) return null
    const html = await response.text()
    if (!html || !html.includes('<')) return null
    const sliced = html.slice(0, 120000)
    return {
      url,
      html: sliced,
      text: htmlToText(sliced)
    }
  } catch {
    return null
  }
}

async function fetchCompanyPages(domain: string): Promise<PageSnapshot[]> {
  const base = `https://${domain}`
  const candidates = [
    base,
    `${base}/about`,
    `${base}/team`,
    `${base}/people`,
    `${base}/leadership`,
    `${base}/company`
  ]

  const pages: PageSnapshot[] = []
  for (const candidate of candidates) {
    if (pages.length >= 3) break
    const snapshot = await fetchPageSnapshot(candidate)
    if (!snapshot) continue
    pages.push(snapshot)
  }
  return pages
}

function pickValidLlmJson(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  return match ? match[0] : null
}

async function inferWithLlm(
  contact: ContactDetail,
  domain: string,
  pages: PageSnapshot[]
): Promise<WebContactGuess> {
  if (pages.length === 0) return { title: null, linkedinUrl: null }

  const context = pages
    .map((page, idx) => {
      const excerpt = page.text.slice(0, 2400)
      return `Page ${idx + 1}: ${page.url}\n${excerpt}`
    })
    .join('\n\n')
    .slice(0, 10000)

  if (!context) return { title: null, linkedinUrl: null }

  try {
    const provider = getProvider('enrichment')
    const userPrompt = [
      "Given the website excerpts below, infer this person's job title and LinkedIn profile URL if clearly supported.",
      `Person: ${contact.fullName}`,
      `Company domain: ${domain}`,
      'Respond with strict JSON only in this shape:',
      '{"title": string|null, "linkedinUrl": string|null}',
      'If uncertain, return null for that field.',
      '',
      context
    ].join('\n')
    const responseText = await provider.generateSummary('', userPrompt)
    const payload = pickValidLlmJson(responseText)
    if (!payload) return { title: null, linkedinUrl: null }
    const parsed = JSON.parse(payload) as { title?: unknown; linkedinUrl?: unknown }
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : null
    const linkedinUrl = normalizeLinkedinUrl(
      typeof parsed.linkedinUrl === 'string' ? parsed.linkedinUrl : null
    )

    return {
      title: title || null,
      linkedinUrl
    }
  } catch {
    return { title: null, linkedinUrl: null }
  }
}

async function inferCompanyIdByDomain(domain: string, userId: string | null): Promise<string | null> {
  const existing = companyRepo.findCompanyIdByDomain(domain)
  if (existing) return existing

  let canonicalName = humanizeDomainName(domain.split('.')[0] || domain)
  try {
    canonicalName = await enrichCompany(domain)
  } catch {
    // Keep heuristic fallback.
  }

  try {
    const created = createCompany({
      canonicalName,
      primaryDomain: domain,
      websiteUrl: `https://${domain}`,
      entityType: 'unknown',
      includeInCompaniesView: true,
      classificationSource: 'auto',
      classificationConfidence: 0.7
    }, userId)
    return created.id
  } catch {
    return companyRepo.findCompanyIdByDomain(domain)
  }
}

function createCompany(
  data: Parameters<typeof companyRepo.createCompany>[0],
  userId: string | null
) {
  return companyRepo.createCompany(data, userId)
}

export function mergeContactEnrichmentResults(
  base: ContactEnrichmentResult,
  web: ContactEnrichmentResult
): ContactEnrichmentResult {
  return {
    scannedContacts: base.scannedContacts,
    updatedNames: base.updatedNames + web.updatedNames,
    updatedLinkedinUrls: base.updatedLinkedinUrls + web.updatedLinkedinUrls,
    updatedTitles: base.updatedTitles + web.updatedTitles,
    linkedCompanies: base.linkedCompanies + web.linkedCompanies,
    webLookups: base.webLookups + web.webLookups,
    skipped: base.skipped + web.skipped
  }
}

/**
 * Attempt to find a contact's LinkedIn URL by scraping their company's website.
 * Returns the URL if found, null otherwise. Free — no external API calls.
 *
 *   contact
 *     │
 *     ▼
 *   inferDomain()  →  null? → return null
 *     │
 *     ▼
 *   fetchCompanyPages()
 *     │
 *     ▼
 *   extractLinkedinUrlsFromHtml() → pickBestLinkedinUrl()
 *     │
 *     ▼
 *   string | null
 */
export async function findLinkedInUrlFromWeb(contact: ContactDetail): Promise<string | null> {
  if (contact.linkedinUrl) return contact.linkedinUrl
  const domain = inferDomain(contact)
  if (!domain) return null
  const pages = await fetchCompanyPages(domain)
  if (pages.length === 0) return null
  const allHtml = pages.map((p) => p.html).join('\n')
  const urls = extractLinkedinUrlsFromHtml(allHtml)
  return pickBestLinkedinUrl(contact, urls)
}

export async function enrichContactsViaWebLookup(
  contactIds: string[],
  userId: string | null,
  options?: ContactEnrichmentOptions
): Promise<ContactEnrichmentResult> {
  const result: ContactEnrichmentResult = {
    scannedContacts: 0,
    updatedNames: 0,
    updatedLinkedinUrls: 0,
    updatedTitles: 0,
    linkedCompanies: 0,
    webLookups: 0,
    skipped: 0
  }

  const rawLimit = options?.webLookupLimit ?? 250
  const safeLimit = Math.max(1, Math.min(rawLimit, 1000))
  const uniqueIds = [...new Set(contactIds.filter((id) => id.trim()))].slice(0, safeLimit)

  for (const contactId of uniqueIds) {
    const contact = contactRepo.getContact(contactId)
    if (!contact) continue
    result.scannedContacts += 1

    const missingCompany = !contact.primaryCompanyId
    const missingLinkedin = !contact.linkedinUrl
    const missingTitle = !contact.title
    if (!missingCompany && !missingLinkedin && !missingTitle) {
      result.skipped += 1
      continue
    }

    const domain = inferDomain(contact)
    if (!domain) {
      result.skipped += 1
      continue
    }

    let touched = false
    let latest: ContactDetail = contact

    if (missingCompany) {
      result.webLookups += 1
      const companyId = await inferCompanyIdByDomain(domain, userId)
      if (companyId) {
        const updated = contactRepo.setContactPrimaryCompany(contact.id, companyId, userId)
        if (updated.primaryCompanyId && updated.primaryCompanyId !== contact.primaryCompanyId) {
          result.linkedCompanies += 1
          touched = true
        }
        latest = updated
      }
    }

    const stillMissingLinkedin = !latest.linkedinUrl
    const stillMissingTitle = !latest.title
    if (stillMissingLinkedin || stillMissingTitle) {
      result.webLookups += 1
      const pages = await fetchCompanyPages(domain)
      const linkedinCandidates = new Set<string>()
      for (const page of pages) {
        for (const url of extractLinkedinUrlsFromHtml(page.html)) {
          linkedinCandidates.add(url)
        }
      }

      let inferredLinkedinUrl = stillMissingLinkedin
        ? pickBestLinkedinUrl(latest, [...linkedinCandidates])
        : null
      let inferredTitle = stillMissingTitle ? inferTitleFromPages(latest, pages) : null

      if ((stillMissingLinkedin && !inferredLinkedinUrl) || (stillMissingTitle && !inferredTitle)) {
        const llmGuess = await inferWithLlm(latest, domain, pages)
        if (!inferredLinkedinUrl) {
          inferredLinkedinUrl = normalizeLinkedinUrl(llmGuess.linkedinUrl)
        }
        if (!inferredTitle) {
          inferredTitle = llmGuess.title?.trim() || null
        }
      }

      const updates: {
        title?: string | null
        linkedinUrl?: string | null
      } = {}
      if (stillMissingTitle && inferredTitle) {
        updates.title = inferredTitle
      }
      if (stillMissingLinkedin && inferredLinkedinUrl) {
        updates.linkedinUrl = inferredLinkedinUrl
      }

      if (Object.keys(updates).length > 0) {
        const updated = contactRepo.updateContact(contact.id, updates, userId)
        if (updates.title && updated.title) {
          result.updatedTitles += 1
        }
        if (updates.linkedinUrl && updated.linkedinUrl) {
          result.updatedLinkedinUrls += 1
        }
        touched = true
      }
    }

    if (!touched) {
      result.skipped += 1
    }
  }

  return result
}
