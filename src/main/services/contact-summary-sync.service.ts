/**
 * Extracts contact profile fields (title, phone, LinkedIn, employer) from a meeting
 * summary using an LLM call, producing proposals for user review before applying.
 *
 * Flow:
 *   emailToContactId (pre-resolved)
 *       │
 *       ▼
 *   Build prompts ──▶ provider.generateSummary() ──▶ safeParseJson()
 *       │                                                    │
 *       │                                            null → return []
 *       │                                                    │
 *       ▼                                                    ▼
 *   For each email:                              Per-contact diff + validation
 *       │                                                    │
 *       ├── getContact(id) null? → skip                      │
 *       ├── isDifferentText() guards                         │
 *       ├── LinkedIn format check                            │
 *       ├── Company lookup (exact → Jaro-Winkler ≥ 0.88)   │
 *       └── Merge fieldSources JSON                         │
 *                                                            ▼
 *                                               ContactSummaryUpdateProposal[]
 */
import { getDatabase } from '../database/connection'
import { getContact } from '../database/repositories/contact.repo'
import { jaroWinkler } from '../utils/jaroWinkler'
import { isDifferentText, normalizeWhitespace } from '../utils/summary-text-utils'
import type { LLMProvider } from '../llm/provider'
import type {
  ContactSummaryUpdateProposal,
  ContactSummaryUpdatePayload,
  ContactSummaryUpdateChange,
  ContactCompanyLinkProposal
} from '../../shared/types/summary'
import { readSummary } from '../storage/file-manager'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { resolveContactsByEmails } from '../database/repositories/contact.repo'

const LINKEDIN_URL_RE = /linkedin\.com\/in\/[\w-]+/i
const FUZZY_THRESHOLD = 0.88

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    // Strip markdown fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function extractString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

// ---------------------------------------------------------------------------
// Company lookup
// ---------------------------------------------------------------------------

interface CompanyRow {
  id: string
  canonical_name: string
}

export function findCompanyByName(name: string): CompanyRow | null {
  const db = getDatabase()
  const trimmed = name.trim()
  if (!trimmed) return null

  // 1. Exact case-insensitive match
  const exact = db
    .prepare(`SELECT id, canonical_name FROM org_companies WHERE lower(trim(canonical_name)) = lower(trim(?))`)
    .get(trimmed) as CompanyRow | undefined
  if (exact) return exact

  // 2. Fuzzy Jaro-Winkler ≥ 0.88 fallback
  const rows = db
    .prepare(`SELECT id, canonical_name FROM org_companies`)
    .all() as CompanyRow[]

  const normalizedInput = normalizeWhitespace(trimmed).toLowerCase()
  let bestRow: CompanyRow | null = null
  let bestScore = 0

  for (const row of rows) {
    const score = jaroWinkler(normalizeWhitespace(row.canonical_name).toLowerCase(), normalizedInput)
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      bestRow = row
    }
  }

  return bestRow
}

// ---------------------------------------------------------------------------
// Core extraction
// ---------------------------------------------------------------------------

/**
 * Build LLM proposals for contact field enrichment from a meeting summary.
 * Calls provider.generateSummary WITHOUT onProgress — returns buffered string.
 */
export async function getContactSummaryUpdateProposals(
  summary: string,
  emailToContactId: Record<string, string>,
  provider: LLMProvider,
  meetingId: string
): Promise<ContactSummaryUpdateProposal[]> {
  if (Object.keys(emailToContactId).length === 0) return []
  const trimmedSummary = summary.trim()
  if (!trimmedSummary) return []

  // Build attendee list with names (looked up from contacts)
  const attendeeLines: string[] = []
  for (const [email, contactId] of Object.entries(emailToContactId)) {
    const contact = getContact(contactId)
    const name = contact?.fullName || email
    attendeeLines.push(`- ${name} (${email})`)
  }

  const systemPrompt =
    'You are a contact data extractor. Extract structured contact information from ' +
    'meeting summaries. Return ONLY valid JSON — no prose, no markdown fences.'

  const userPrompt =
    'Extract contact information for each person listed below from this meeting summary.\n' +
    'Return only what is explicitly stated — do not infer or guess.\n\n' +
    'Attendees:\n' +
    attendeeLines.join('\n') +
    '\n\nSummary:\n' +
    trimmedSummary +
    '\n\nReturn JSON keyed by email address:\n' +
    '{\n' +
    '  "email@example.com": { "title": "...", "phone": "...", "linkedinUrl": "...", "company": "..." },\n' +
    '  "other@example.com": { "title": null, "phone": null, "linkedinUrl": null, "company": null }\n' +
    '}\n' +
    'Set each field to null if not explicitly mentioned in the summary.'

  let responseText: string
  try {
    responseText = await provider.generateSummary(systemPrompt, userPrompt)
  } catch (err) {
    console.error('[Contact AutoFill] LLM call failed:', err)
    return []
  }

  const parsed = safeParseJson(responseText)
  if (!parsed) {
    console.warn('[Contact AutoFill] Could not parse LLM response as JSON')
    return []
  }

  const proposals: ContactSummaryUpdateProposal[] = []

  for (const [email, contactId] of Object.entries(emailToContactId)) {
    const emailKey = email.toLowerCase().trim()
    const extracted = parsed[emailKey] ?? parsed[email]
    if (!extracted || typeof extracted !== 'object') continue

    const contact = getContact(contactId)
    if (!contact) continue

    const rawTitle = extractString((extracted as Record<string, unknown>).title)
    const rawPhone = extractString((extracted as Record<string, unknown>).phone)
    const rawLinkedin = extractString((extracted as Record<string, unknown>).linkedinUrl)
    const rawCompany = extractString((extracted as Record<string, unknown>).company)

    const updates: ContactSummaryUpdatePayload = {}
    const changes: ContactSummaryUpdateChange[] = []

    if (rawTitle && isDifferentText(rawTitle, contact.title)) {
      updates.title = rawTitle
      changes.push({ field: 'title', from: contact.title, to: rawTitle })
    }

    if (rawPhone && isDifferentText(rawPhone, contact.phone)) {
      updates.phone = rawPhone
      changes.push({ field: 'phone', from: contact.phone, to: rawPhone })
    }

    if (rawLinkedin && LINKEDIN_URL_RE.test(rawLinkedin) && isDifferentText(rawLinkedin, contact.linkedinUrl)) {
      updates.linkedinUrl = rawLinkedin
      changes.push({ field: 'linkedinUrl', from: contact.linkedinUrl, to: rawLinkedin })
    }

    // Build company link proposal if company name found and contact has no primary company
    let companyLink: ContactCompanyLinkProposal | undefined
    if (rawCompany && !contact.primaryCompanyId) {
      const matched = findCompanyByName(rawCompany)
      if (matched) {
        companyLink = { companyId: matched.id, companyName: matched.canonical_name }
        changes.push({ field: 'company', from: null, to: matched.canonical_name })
      }
    }

    // Only produce a proposal if there are actual changes
    if (changes.length === 0) continue

    // Merge fieldSources: parse existing JSON, add new sources for changed text fields
    const existingSources: Record<string, string> = {}
    if (contact.fieldSources) {
      try {
        const parsed2 = JSON.parse(contact.fieldSources)
        if (parsed2 && typeof parsed2 === 'object') {
          Object.assign(existingSources, parsed2)
        }
      } catch { /* ignore malformed stored JSON */ }
    }

    if (updates.title) existingSources.title = meetingId
    if (updates.phone) existingSources.phone = meetingId
    if (updates.linkedinUrl) existingSources.linkedinUrl = meetingId

    if (Object.keys(existingSources).length > 0) {
      updates.fieldSources = JSON.stringify(existingSources)
    }

    proposals.push({
      contactId,
      contactName: contact.fullName,
      updates,
      companyLink,
      changes
    })
  }

  return proposals
}

/**
 * On-demand enrichment: loads meeting from DB, reads its summary file,
 * resolves attendee emails, then runs extraction.
 */
export async function getContactSummaryUpdateProposalsFromMeetingId(
  meetingId: string,
  provider: LLMProvider
): Promise<ContactSummaryUpdateProposal[]> {
  const meeting = meetingRepo.getMeeting(meetingId)
  if (!meeting) return []
  if (!meeting.summaryPath) return []

  const summary = readSummary(meeting.summaryPath)
  if (!summary) return []

  const emails = meeting.attendeeEmails || []
  if (emails.length === 0) return []

  const emailToContactId = resolveContactsByEmails(emails)
  return getContactSummaryUpdateProposals(summary, emailToContactId, provider, meetingId)
}
