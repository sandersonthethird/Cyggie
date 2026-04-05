/**
 * LinkedIn Enrichment Service
 *
 * Loads a LinkedIn profile in a hidden Electron BrowserWindow using the default
 * session (so LinkedIn cookies are shared), extracts profile text, parses it via
 * an LLM, and upserts the structured data into the contact record.
 *
 * Data flow:
 *
 *   contactId
 *     │
 *     ▼
 *   contact.repo.getContact()
 *     │
 *     ▼
 *   loadLinkedInProfile(linkedinUrl)          ← hidden BrowserWindow (default session)
 *     │  [throws: no_linkedin_url, login_required, profile_load_failed, profile_timeout]
 *     ▼
 *   parseLinkedInProfile(text, name, provider) ← LLM (haiku)
 *     │  [throws: llm_failed, llm_bad_json, no_data]
 *     ▼
 *   company auto-link via findCompanyIdByNameOrDomain()
 *     │
 *     ▼
 *   contact.repo.updateContact()
 *     │
 *     ▼
 *   LinkedInEnrichmentResult
 *
 * Key design decisions:
 *   - No `sandbox: true`: deliberately omitted so the default Electron session
 *     (with LinkedIn cookies) is shared. contextIsolation: true prevents renderer
 *     JS from accessing Node. Intentional trade-off for session sharing.
 *   - SPA wait: poll `document.body.innerText.length > 5000` in 500ms intervals.
 *     Content-based — immune to LinkedIn CSS class changes.
 *   - Login detection: check both URL patterns and innerText for login wall signals.
 */

import { BrowserWindow } from 'electron'
import { getContact, updateContact } from '../database/repositories/contact.repo'
import { findCompanyIdByNameOrDomain } from '../database/repositories/org-company.repo'
import { normalizeLinkedinUrl } from '../database/repositories/contact-utils'
import { getProvider } from '../llm/provider-factory'
import { safeParseJson, extractString, extractNumber } from '../utils/json-utils'
import type { LLMProvider } from '../llm/provider'
import type {
  LinkedInWorkEntry,
  LinkedInEducationEntry,
  LinkedInEnrichmentResult,
} from '../../shared/types/contact'
import { LinkedInEnrichError } from '../../shared/types/contact'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LINKEDIN_SPA_SETTLE_MS  = 4_000
const LINKEDIN_TIMEOUT_MS     = 20_000
const LINKEDIN_MAX_TEXT_CHARS = 30_000
const LINKEDIN_BATCH_DELAY_MS = 2_000

const LOGIN_URL_PATTERNS = ['/login', '/authwall', '/checkpoint', '/uas/login']

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Truncate text at a word boundary near maxChars.
 * Walks back from maxChars to the last newline (must be > 80% of maxChars).
 * Falls back to a hard cut if no suitable newline is found.
 */
function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const minBoundary = Math.floor(maxChars * 0.8)
  const slice = text.slice(0, maxChars)
  const lastNewline = slice.lastIndexOf('\n')
  if (lastNewline >= minBoundary) return text.slice(0, lastNewline)
  return slice
}

function isLoginUrl(url: string): boolean {
  return LOGIN_URL_PATTERNS.some((pattern) => url.includes(pattern))
}

// ---------------------------------------------------------------------------
// loadLinkedInProfile
// ---------------------------------------------------------------------------

/**
 * Loads a LinkedIn profile URL in a hidden BrowserWindow and returns the
 * visible text content. Uses the default Electron session so LinkedIn cookies
 * are available.
 *
 * NOTE: No sandbox: true — needed to share the default session cookie jar.
 * contextIsolation: true still isolates renderer JS from Node.
 */
export async function loadLinkedInProfile(url: string): Promise<string> {
  const normalized = normalizeLinkedinUrl(url)
  if (!normalized) {
    throw new LinkedInEnrichError('profile_load_failed', 'Invalid LinkedIn URL')
  }
  if (!normalized.includes('/in/')) {
    throw new LinkedInEnrichError('profile_load_failed', 'URL does not appear to be a LinkedIn person profile (missing /in/)')
  }

  // NOTE: no sandbox — deliberate for session cookie sharing. contextIsolation prevents
  // renderer JS from accessing Node APIs.
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null

  try {
    await Promise.race([
      (async () => {
        try {
          await win.loadURL(normalized)
        } catch (err) {
          throw new LinkedInEnrichError('profile_load_failed', `Failed to load LinkedIn URL: ${String(err)}`)
        }
      })(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new LinkedInEnrichError('profile_timeout', 'LinkedIn profile load timed out after 20s')),
          LINKEDIN_TIMEOUT_MS
        )
        win.webContents.on('did-fail-load', (_ev, _code, desc) => {
          reject(new LinkedInEnrichError('profile_load_failed', `LinkedIn page failed to load: ${desc}`))
        })
      }),
    ])

    if (timeoutHandle) clearTimeout(timeoutHandle)

    // Check if we were redirected to a login page
    const currentUrl = win.webContents.getURL()
    if (isLoginUrl(currentUrl)) {
      throw new LinkedInEnrichError('login_required', 'LinkedIn requires sign-in — please sign in and try again')
    }

    // Poll for SPA content to render (LinkedIn renders content asynchronously)
    const deadline = Date.now() + LINKEDIN_SPA_SETTLE_MS
    while (Date.now() < deadline) {
      try {
        const ready: boolean = await win.webContents.executeJavaScript(
          'document.body ? document.body.innerText.length > 5000 : false'
        )
        if (ready) break
      } catch {
        // executeJavaScript can throw if window destroyed mid-poll — break out
        break
      }
      await delay(500)
    }

    const innerText: string = await win.webContents.executeJavaScript(
      'document.body ? document.body.innerText : ""'
    )

    // Detect login wall in page content
    if (innerText.length < 500 || /join linkedin|sign in/i.test(innerText.slice(0, 500))) {
      throw new LinkedInEnrichError('login_required', 'LinkedIn sign-in wall detected — please sign in and try again')
    }

    return truncateAtWordBoundary(innerText, LINKEDIN_MAX_TEXT_CHARS)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    try { win.destroy() } catch { /* already destroyed */ }
  }
}

// ---------------------------------------------------------------------------
// parseLinkedInProfile
// ---------------------------------------------------------------------------

interface LinkedInProfileData {
  headline: string | null
  workHistory: LinkedInWorkEntry[]
  educationHistory: LinkedInEducationEntry[]
  skills: string[]
  inferredTitle: string | null
  inferredCity: string | null
  inferredState: string | null
}

export async function parseLinkedInProfile(
  pageText: string,
  contactName: string,
  provider: LLMProvider
): Promise<LinkedInProfileData> {
  const systemPrompt =
    'You are a professional profile data extractor. Extract structured information from LinkedIn ' +
    'profile text. Return ONLY valid JSON — no prose, no markdown fences. Set fields to null or ' +
    'empty array if not present. Format dates as YYYY-MM if month known, or YYYY if only year known.'

  const userPrompt = `Extract the LinkedIn profile for: ${contactName}

Profile text:
${pageText}

Return JSON with exactly these fields:
{
  "headline": LinkedIn headline (string or null),
  "workHistory": [{
    "company": company name (string),
    "title": job title (string),
    "startDate": "YYYY-MM" or "YYYY" (string or null),
    "endDate": "YYYY-MM" or "YYYY" or null if current (string or null),
    "isCurrent": true if current role (boolean),
    "description": brief description if present (string or null)
  }],
  "educationHistory": [{
    "school": school name (string),
    "degree": e.g. "Bachelor of Science" (string or null),
    "field": field of study (string or null),
    "startYear": number or null,
    "endYear": number or null
  }],
  "skills": top skills listed (array of strings, max 15),
  "inferredTitle": most recent/current job title (string or null),
  "inferredCity": city (string or null),
  "inferredState": US state abbreviation (string or null)
}`

  let rawText: string
  try {
    rawText = await provider.complete(systemPrompt, userPrompt)
  } catch (err) {
    throw new LinkedInEnrichError('llm_failed', `LLM call failed: ${String(err)}`)
  }

  if (!rawText?.trim()) {
    throw new LinkedInEnrichError('llm_bad_json', 'LLM returned empty response')
  }

  const raw = safeParseJson(rawText)
  if (!raw) {
    throw new LinkedInEnrichError('llm_bad_json', `LLM returned non-JSON response: ${rawText.slice(0, 200)}`)
  }

  const workHistory: LinkedInWorkEntry[] = Array.isArray(raw.workHistory)
    ? (raw.workHistory as unknown[]).map((entry) => {
        const e = entry as Record<string, unknown>
        return {
          company: extractString(e.company) ?? '',
          title: extractString(e.title) ?? '',
          startDate: extractString(e.startDate) ?? null,
          endDate: extractString(e.endDate) ?? null,
          isCurrent: Boolean(e.isCurrent),
          description: extractString(e.description) ?? null,
        }
      }).filter((e) => e.company && e.title)
    : []

  const educationHistory: LinkedInEducationEntry[] = Array.isArray(raw.educationHistory)
    ? (raw.educationHistory as unknown[]).map((entry) => {
        const e = entry as Record<string, unknown>
        return {
          school: extractString(e.school) ?? '',
          degree: extractString(e.degree) ?? null,
          field: extractString(e.field) ?? null,
          startYear: extractNumber(e.startYear) ?? null,
          endYear: extractNumber(e.endYear) ?? null,
        }
      }).filter((e) => e.school)
    : []

  const skills: string[] = Array.isArray(raw.skills)
    ? (raw.skills as unknown[]).filter((s) => typeof s === 'string').slice(0, 15) as string[]
    : []

  const headline = extractString(raw.headline)
  const inferredTitle = extractString(raw.inferredTitle)
  const inferredCity = extractString(raw.inferredCity)
  const inferredState = extractString(raw.inferredState)

  // Throw no_data only if completely empty
  if (workHistory.length === 0 && educationHistory.length === 0 && !headline && !inferredTitle) {
    throw new LinkedInEnrichError(
      'no_data',
      'No profile data found — the page may not have loaded correctly'
    )
  }

  return { headline, workHistory, educationHistory, skills, inferredTitle, inferredCity, inferredState }
}

// ---------------------------------------------------------------------------
// enrichContactFromLinkedIn
// ---------------------------------------------------------------------------

export async function enrichContactFromLinkedIn(
  contactId: string,
  userId: string | null
): Promise<LinkedInEnrichmentResult> {
  const contact = getContact(contactId)
  if (!contact) throw new Error('Contact not found')
  if (!contact.linkedinUrl) {
    throw new LinkedInEnrichError('no_linkedin_url', 'Contact has no LinkedIn URL')
  }

  const pageText = await loadLinkedInProfile(contact.linkedinUrl)
  const provider = getProvider('enrichment')
  const profileData = await parseLinkedInProfile(pageText, contact.fullName, provider)

  // Auto-link companies in work history
  let companiesLinked = 0
  const linkedWorkHistory = profileData.workHistory.map((entry) => {
    const companyId = findCompanyIdByNameOrDomain(entry.company, null)
    if (companyId) companiesLinked++
    return { ...entry, companyId: companyId ?? null }
  })

  // Parse existing field_sources safely — malformed JSON falls back to {}
  const existingFieldSources = (() => {
    try { return JSON.parse(contact.fieldSources ?? '{}') as Record<string, unknown> } catch { return {} }
  })()
  const newFieldSources = { ...existingFieldSources }

  const updates: Record<string, unknown> = {
    workHistory: JSON.stringify(linkedWorkHistory),
    educationHistory: JSON.stringify(profileData.educationHistory),
    linkedinHeadline: profileData.headline,
    linkedinSkills: JSON.stringify(profileData.skills),
    linkedinEnrichedAt: new Date().toISOString(),
  }

  // Only backfill if blank — never overwrite user data
  if (!contact.title && profileData.inferredTitle) {
    updates.title = profileData.inferredTitle
    newFieldSources.title = 'linkedin'
  }
  if (!contact.city && profileData.inferredCity) {
    updates.city = profileData.inferredCity
    newFieldSources.city = 'linkedin'
  }
  if (!contact.state && profileData.inferredState) {
    updates.state = profileData.inferredState
    newFieldSources.state = 'linkedin'
  }
  updates.fieldSources = JSON.stringify(newFieldSources)

  let updatedContact
  try {
    updatedContact = updateContact(contactId, updates, userId)
  } catch (err) {
    throw new Error(`Failed to save LinkedIn enrichment: ${String(err)}`)
  }

  return {
    contact: updatedContact,
    summary: {
      positionCount: linkedWorkHistory.length,
      schoolCount: profileData.educationHistory.length,
      skillCount: profileData.skills.length,
      companiesLinked,
    }
  }
}

// ---------------------------------------------------------------------------
// Batch enrichment
// ---------------------------------------------------------------------------

export interface LinkedInBatchProgress {
  success: boolean
  contactId: string
  errorCode?: string
  summary?: LinkedInEnrichmentResult['summary']
}

export interface LinkedInBatchResult {
  enriched: number
  failed: number
  loginRequired: boolean
  paused: boolean
}

export async function enrichContactsFromLinkedInBatch(
  contactIds: string[],
  userId: string | null,
  signal: AbortSignal,
  onProgress: (current: number, total: number, progress: LinkedInBatchProgress) => void
): Promise<LinkedInBatchResult> {
  let enriched = 0
  let failed = 0
  const total = contactIds.length

  for (let i = 0; i < contactIds.length; i++) {
    if (signal.aborted) {
      return { enriched, failed, loginRequired: false, paused: true }
    }

    const contactId = contactIds[i]!

    try {
      const result = await enrichContactFromLinkedIn(contactId, userId)
      onProgress(i + 1, total, { success: true, contactId, summary: result.summary })
      enriched++
    } catch (err) {
      if (err instanceof LinkedInEnrichError && err.code === 'login_required') {
        onProgress(i + 1, total, { success: false, contactId, errorCode: 'login_required' })
        return { enriched, failed, loginRequired: true, paused: true }
      }
      const errorCode = err instanceof LinkedInEnrichError ? err.code : 'unknown'
      onProgress(i + 1, total, { success: false, contactId, errorCode })
      failed++
    }

    // Delay between requests to avoid rate-limiting (skip after last item)
    if (i < contactIds.length - 1 && !signal.aborted) {
      await delay(LINKEDIN_BATCH_DELAY_MS)
    }
  }

  return { enriched, failed, loginRequired: false, paused: false }
}
