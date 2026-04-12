/**
 * Exa LinkedIn Discovery Service
 *
 * Discovers a contact's LinkedIn profile URL via two cascading strategies:
 *
 *   Strategy 1 — Web scrape (free):
 *     Fetch company website pages and extract LinkedIn URLs from HTML.
 *     Uses findLinkedInUrlFromWeb() from contact-web-enrichment.ts.
 *
 *   Strategy 2 — Exa search (API credit):
 *     Search for the contact by name + company on linkedin.com/in/ via Exa.
 *
 * Data flow (findLinkedInUrlWithCascade):
 *
 *   contact
 *     │
 *     ▼
 *   findLinkedInUrlFromWeb()      ← free: scrape company site
 *     │ found?        null?
 *     ▼                ▼
 *   return url    findLinkedInUrlViaExa(name, company, key)
 *                       │ [throws: ExaDiscoveryError on 401]
 *                       │ [returns null on 429 exhausted, timeout, bad shape]
 *                       ▼
 *                  normalizeLinkedinUrl()
 *                       │
 *                       ▼
 *                  string | null
 *
 * Error codes:
 *   ExaDiscoveryError('exa_auth')  — invalid API key (HTTP 401)
 *   ExaDiscoveryError('unknown')   — unexpected error
 *
 * 'no_exa_key' is returned by the IPC handler before this service is called.
 */

import Exa from 'exa-js'
import { normalizeLinkedinUrl } from '../database/repositories/contact-utils'
import { findLinkedInUrlFromWeb } from './contact-web-enrichment'
import { getContact } from '../database/repositories/contact.repo'
import { logAudit } from '../database/repositories/audit.repo'
import type { ContactDetail } from '../../shared/types/contact'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXA_TIMEOUT_MS    = 10_000
const EXA_BATCH_DELAY_MS = 1_000
const EXA_RETRY_DELAY_MS = 5_000

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ExaDiscoveryError extends Error {
  constructor(public readonly code: 'exa_auth' | 'unknown', message: string) {
    super(message)
    this.name = 'ExaDiscoveryError'
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Exa search timed out after ${ms}ms`)), ms)
  )
}

// ---------------------------------------------------------------------------
// findLinkedInUrlViaExa (internal)
// ---------------------------------------------------------------------------

async function findLinkedInUrlViaExa(
  name: string,
  company: string | null | undefined,
  exaApiKey: string
): Promise<string | null> {
  const query = `"${name}"${company ? ` "${company}"` : ''} site:linkedin.com/in/`
  const exa = new Exa(exaApiKey)

  const attemptSearch = async (): Promise<string | null> => {
    let response: { results?: { url?: string }[] }
    try {
      response = await Promise.race([
        exa.search(query, { numResults: 3, contents: false }),
        makeTimeout(EXA_TIMEOUT_MS),
      ]) as { results?: { url?: string }[] }
    } catch (err) {
      // Check for ExaError with statusCode
      const exaErr = err as { statusCode?: number; message?: string } | Error
      const status = (exaErr as { statusCode?: number }).statusCode
      if (status === 401) {
        throw new ExaDiscoveryError('exa_auth', 'Invalid Exa API key (401)')
      }
      if (status === 429) {
        return null // signal rate limit to caller
      }
      // timeout or other network error
      console.warn('[Exa Discovery] Search failed:', (err as Error).message ?? String(err))
      return null
    }

    const url = Array.isArray(response?.results) ? response.results[0]?.url : undefined
    return url ? normalizeLinkedinUrl(url) : null
  }

  // First attempt
  const firstResult = await attemptSearch()
  if (firstResult !== null) return firstResult

  // null could mean not found OR 429. We retry once after a delay (handles 429 backoff).
  // If also null after retry, give up.
  await delay(EXA_RETRY_DELAY_MS)

  try {
    let response: { results?: { url?: string }[] }
    try {
      response = await Promise.race([
        exa.search(query, { numResults: 3, contents: false }),
        makeTimeout(EXA_TIMEOUT_MS),
      ]) as { results?: { url?: string }[] }
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 401) throw new ExaDiscoveryError('exa_auth', 'Invalid Exa API key (401)')
      console.warn('[Exa Discovery] Retry failed:', (err as Error).message ?? String(err))
      return null
    }
    const url = Array.isArray(response?.results) ? response.results[0]?.url : undefined
    return url ? normalizeLinkedinUrl(url) : null
  } catch (err) {
    if (err instanceof ExaDiscoveryError) throw err
    return null
  }
}

// ---------------------------------------------------------------------------
// findLinkedInUrlWithCascade (exported)
// ---------------------------------------------------------------------------

export async function findLinkedInUrlWithCascade(
  contact: ContactDetail,
  exaApiKey: string
): Promise<string | null> {
  // Step 1: free web scrape
  const webUrl = await findLinkedInUrlFromWeb(contact)
  if (webUrl) {
    console.log(`[Exa Discovery] contact=${contact.id} name="${contact.fullName}" source=web`)
    return webUrl
  }

  // Step 2: Exa search
  const exaUrl = await findLinkedInUrlViaExa(contact.fullName, contact.primaryCompanyName, exaApiKey)
  if (exaUrl) {
    console.log(`[Exa Discovery] contact=${contact.id} name="${contact.fullName}" source=exa`)
  } else {
    console.log(`[Exa Discovery] contact=${contact.id} name="${contact.fullName}" source=not_found`)
  }
  return exaUrl
}

// ---------------------------------------------------------------------------
// Batch result types
// ---------------------------------------------------------------------------

export interface ExaBatchResultEntry {
  contactId: string
  contactName: string
  foundUrl: string | null
}

export interface ExaBatchResult {
  found: number
  notFound: number
  skipped: number
  results: ExaBatchResultEntry[]
}

export interface ExaBatchProgress {
  current: number
  total: number
  contactId: string
  contactName: string
  foundUrl: string | null
}

// ---------------------------------------------------------------------------
// findLinkedInUrlsForContactsBatch (exported)
// ---------------------------------------------------------------------------

export async function findLinkedInUrlsForContactsBatch(
  contactIds: string[],
  exaApiKey: string,
  signal: AbortSignal,
  onProgress: (progress: ExaBatchProgress) => void,
  userId: string | null
): Promise<ExaBatchResult> {
  const result: ExaBatchResult = { found: 0, notFound: 0, skipped: 0, results: [] }
  const total = contactIds.length

  for (let i = 0; i < contactIds.length; i++) {
    if (signal.aborted) break

    const contactId = contactIds[i]
    const contact = getContact(contactId)

    if (!contact) {
      console.warn(`[Exa Discovery] Skipping contact=${contactId} — not found (deleted?)`)
      result.skipped += 1
      result.results.push({ contactId, contactName: '', foundUrl: null })
      continue
    }

    if (contact.linkedinUrl) {
      // Already has a URL — skip
      result.skipped += 1
      result.results.push({ contactId, contactName: contact.fullName, foundUrl: contact.linkedinUrl })
      onProgress({ current: i + 1, total, contactId, contactName: contact.fullName, foundUrl: contact.linkedinUrl })
      continue
    }

    let foundUrl: string | null = null
    try {
      foundUrl = await findLinkedInUrlWithCascade(contact, exaApiKey)
    } catch (err) {
      if (err instanceof ExaDiscoveryError && err.code === 'exa_auth') {
        // Auth failure is fatal — abort batch
        throw err
      }
      console.warn(`[Exa Discovery] Error for contact=${contactId}:`, (err as Error).message)
      result.skipped += 1
      result.results.push({ contactId, contactName: contact.fullName, foundUrl: null })
      onProgress({ current: i + 1, total, contactId, contactName: contact.fullName, foundUrl: null })
      if (i < contactIds.length - 1) await delay(EXA_BATCH_DELAY_MS)
      continue
    }

    if (foundUrl) {
      result.found += 1
    } else {
      result.notFound += 1
    }

    result.results.push({ contactId, contactName: contact.fullName, foundUrl })
    onProgress({ current: i + 1, total, contactId, contactName: contact.fullName, foundUrl })

    if (i < contactIds.length - 1 && !signal.aborted) {
      await delay(EXA_BATCH_DELAY_MS)
    }
  }

  console.log(
    `[Exa Discovery] Batch complete: found=${result.found} notFound=${result.notFound} skipped=${result.skipped}`
  )

  logAudit(userId, 'contact', 'exa-linkedin-batch', 'update', {
    found: result.found,
    notFound: result.notFound,
    skipped: result.skipped,
    total: contactIds.length
  })

  return result
}
