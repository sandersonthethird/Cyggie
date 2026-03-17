/**
 * Extracts contact profile fields from a meeting summary using an LLM call,
 * producing proposals for user review before applying.
 *
 * Flow:
 *   emailToContactId (pre-resolved) + meetingId
 *       │
 *       ├─▶ readHiddenContactFields()      ← 'cyggie:contact-hidden-fields' pref
 *       ├─▶ listFieldDefinitions('contact') → filter !isBuiltin, !hidden, !ref type
 *       │
 *       ▼
 *   Build LLM prompt:
 *     ├── Built-in: title, phone, linkedinUrl, company
 *     ├── Investor fields [if not hidden]: fundSize, checkMin/Max, stageFocus, sectorFocus
 *     └── Custom fields [if not hidden, !ref type]: label, type, options
 *       │
 *       ▼
 *   provider.generateSummary() ──▶ safeParseJson()
 *       │                                │
 *   LLM error → []              null → []
 *       │
 *       ▼
 *   For each email (contact):
 *     ├── getContact(id) null? → skip
 *     ├── Extract built-in fields (title / phone / linkedin / company)
 *     ├── Extract investor fields → compare vs contact.*
 *     ├── Extract custom fields  → getFieldValuesForEntity() → compare
 *     ├── if changes.length === 0 → skip            ← guard AFTER all field blocks
 *     ├── Merge fieldSources JSON
 *     └── Push ContactSummaryUpdateProposal
 *           { updates, customFieldUpdates?, changes, companyLink? }
 *                                            ▼
 *                               ContactSummaryUpdateProposal[]
 */
import { getDatabase } from '../database/connection'
import { getContact } from '../database/repositories/contact.repo'
import { listFieldDefinitions, getFieldValuesForEntity } from '../database/repositories/custom-fields.repo'
import { jaroWinkler } from '../utils/jaroWinkler'
import { isDifferentText, normalizeWhitespace } from '../utils/summary-text-utils'
import type { LLMProvider } from '../llm/provider'
import type { CustomFieldDefinition } from '../../shared/types/custom-fields'
import type {
  ContactSummaryUpdateProposal,
  ContactSummaryUpdatePayload,
  ContactSummaryUpdateChange,
  ContactCompanyLinkProposal,
  CustomFieldProposedUpdate
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

function extractNumber(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return isFinite(n) ? n : null
}

function parseOptions(def: CustomFieldDefinition): string[] {
  if (!def.optionsJson) return []
  try {
    return JSON.parse(def.optionsJson)
  } catch {
    return []
  }
}

function readHiddenContactFields(): Set<string> {
  try {
    const db = getDatabase()
    const row = db.prepare(`SELECT value FROM user_preferences WHERE key = ?`)
      .get('cyggie:contact-hidden-fields') as { value: string } | undefined
    const arr: string[] = row ? JSON.parse(row.value) : []
    return new Set(arr)
  } catch {
    return new Set()
  }
}

function buildCustomFieldPromptLines(defs: CustomFieldDefinition[]): string {
  return defs.map(def => {
    const base = `  "${def.fieldKey}" (${def.label})`
    if (def.fieldType === 'select' || def.fieldType === 'multiselect') {
      const opts = parseOptions(def)
      if (opts.length > 0) {
        const type = def.fieldType === 'multiselect' ? 'array, each item one of' : 'one of'
        return `${base}: ${type} [${opts.join(', ')}] or null`
      }
    }
    if (def.fieldType === 'number' || def.fieldType === 'currency') return `${base}: number or null`
    if (def.fieldType === 'boolean') return `${base}: true or false or null`
    if (def.fieldType === 'date') return `${base}: ISO date YYYY-MM-DD or null`
    return `${base}: string or null`
  }).join('\n')
}

export function matchSelectOption(raw: string, options: string[]): string | null {
  const norm = normalizeWhitespace(raw).toLowerCase()
  let best: string | null = null
  let bestScore = 0
  for (const opt of options) {
    const score = jaroWinkler(normalizeWhitespace(opt).toLowerCase(), norm)
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      best = opt
    }
  }
  return best
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

  // Read hidden fields pref and non-builtin custom field definitions
  const hiddenFields = readHiddenContactFields()
  const customDefs = listFieldDefinitions('contact').filter(
    d => !d.isBuiltin &&
         !hiddenFields.has(d.fieldKey) &&
         d.fieldType !== 'contact_ref' &&
         d.fieldType !== 'company_ref'
  )

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

  // Investor field descriptors (conditionally include if not hidden)
  const investorFieldLines = [
    ['fundSize',              'fund size as a number (USD)'],
    ['typicalCheckSizeMin',   'typical check size minimum (USD number)'],
    ['typicalCheckSizeMax',   'typical check size maximum (USD number)'],
    ['investmentStageFocus',  'investment stage focus (e.g. "Seed, Series A")'],
    ['investmentSectorFocus', 'investment sector focus'],
  ].filter(([key]) => !hiddenFields.has(key!))
    .map(([key, desc]) => `  "${key}": ${desc} or null`)
    .join('\n')

  // Example JSON fields for the structural template
  const jsonFieldsExample = [
    '"title": "..."', '"phone": "..."', '"linkedinUrl": "..."', '"company": "..."',
    ...(!hiddenFields.has('fundSize')              ? ['"fundSize": 50000000']           : []),
    ...(!hiddenFields.has('typicalCheckSizeMin')   ? ['"typicalCheckSizeMin": 250000']  : []),
    ...(!hiddenFields.has('typicalCheckSizeMax')   ? ['"typicalCheckSizeMax": 2000000'] : []),
    ...(!hiddenFields.has('investmentStageFocus')  ? ['"investmentStageFocus": "..."']  : []),
    ...(!hiddenFields.has('investmentSectorFocus') ? ['"investmentSectorFocus": "..."'] : []),
    ...customDefs.map(d => `"${d.fieldKey}": ...`),
  ].join(', ')

  const investorNotes = investorFieldLines.length > 0
    ? `\n\nInvestor fields to extract:\n${investorFieldLines}`
    : ''

  const customFieldNotes = customDefs.length > 0
    ? `\n\nCustom fields to extract:\n${buildCustomFieldPromptLines(customDefs)}`
    : ''

  const userPrompt =
    'Extract contact information for each person listed below from this meeting summary.\n' +
    'Return only what is explicitly stated — do not infer or guess.\n\n' +
    'Attendees:\n' +
    attendeeLines.join('\n') +
    '\n\nSummary:\n' +
    trimmedSummary +
    '\n\nReturn JSON keyed by email address:\n' +
    `{\n  "email@example.com": { ${jsonFieldsExample} }\n}` +
    '\nSet each field to null if not explicitly mentioned in the summary.' +
    investorNotes +
    customFieldNotes

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

    // --- Investor fields ---
    const rawFundSize       = extractNumber((extracted as Record<string, unknown>).fundSize)
    const rawCheckMin       = extractNumber((extracted as Record<string, unknown>).typicalCheckSizeMin)
    const rawCheckMax       = extractNumber((extracted as Record<string, unknown>).typicalCheckSizeMax)
    const rawStageFocus     = extractString((extracted as Record<string, unknown>).investmentStageFocus)
    const rawSectorFocus    = extractString((extracted as Record<string, unknown>).investmentSectorFocus)

    if (rawFundSize != null && rawFundSize !== (contact as Record<string, unknown>).fundSize && !hiddenFields.has('fundSize')) {
      updates.fundSize = rawFundSize
      const prev = (contact as Record<string, unknown>).fundSize
      changes.push({ field: 'fundSize', from: prev != null ? String(prev) : null, to: String(rawFundSize) })
    }
    if (rawCheckMin != null && rawCheckMin !== (contact as Record<string, unknown>).typicalCheckSizeMin && !hiddenFields.has('typicalCheckSizeMin')) {
      updates.typicalCheckSizeMin = rawCheckMin
      const prev = (contact as Record<string, unknown>).typicalCheckSizeMin
      changes.push({ field: 'typicalCheckSizeMin', from: prev != null ? String(prev) : null, to: String(rawCheckMin) })
    }
    if (rawCheckMax != null && rawCheckMax !== (contact as Record<string, unknown>).typicalCheckSizeMax && !hiddenFields.has('typicalCheckSizeMax')) {
      updates.typicalCheckSizeMax = rawCheckMax
      const prev = (contact as Record<string, unknown>).typicalCheckSizeMax
      changes.push({ field: 'typicalCheckSizeMax', from: prev != null ? String(prev) : null, to: String(rawCheckMax) })
    }
    if (rawStageFocus && !hiddenFields.has('investmentStageFocus') && isDifferentText(rawStageFocus, (contact as Record<string, unknown>).investmentStageFocus as string | null)) {
      updates.investmentStageFocus = rawStageFocus
      changes.push({ field: 'investmentStageFocus', from: (contact as Record<string, unknown>).investmentStageFocus as string | null, to: rawStageFocus })
    }
    if (rawSectorFocus && !hiddenFields.has('investmentSectorFocus') && isDifferentText(rawSectorFocus, (contact as Record<string, unknown>).investmentSectorFocus as string | null)) {
      updates.investmentSectorFocus = rawSectorFocus
      changes.push({ field: 'investmentSectorFocus', from: (contact as Record<string, unknown>).investmentSectorFocus as string | null, to: rawSectorFocus })
    }

    // --- Custom fields ---
    const customFieldUpdates: CustomFieldProposedUpdate[] = []

    if (customDefs.length > 0) {
      const currentValues = getFieldValuesForEntity('contact', contactId)
      const currentValueMap = new Map(currentValues.map(v => [v.id, v]))

      for (const def of customDefs) {
        const rawVal = (extracted as Record<string, unknown>)[def.fieldKey]
        if (rawVal == null) continue

        let parsedValue: string | number | boolean | string[] | null = null
        let fromDisplay: string | null = null
        let toDisplay = ''

        const existing = currentValueMap.get(def.id)

        if (def.fieldType === 'text' || def.fieldType === 'url' || def.fieldType === 'textarea') {
          const s = extractString(rawVal)
          if (!s || !isDifferentText(s, existing?.value?.valueText ?? null)) continue
          parsedValue = s
          fromDisplay = existing?.value?.valueText ?? null
          toDisplay = s

        } else if (def.fieldType === 'number' || def.fieldType === 'currency') {
          const n = extractNumber(rawVal)
          if (n == null || n === (existing?.value?.valueNumber ?? null)) continue
          parsedValue = n
          fromDisplay = existing?.value?.valueNumber != null ? String(existing.value.valueNumber) : null
          toDisplay = String(n)

        } else if (def.fieldType === 'boolean') {
          if (typeof rawVal !== 'boolean') continue
          const current = existing?.value?.valueBoolean ?? null
          if (rawVal === current) continue
          parsedValue = rawVal
          fromDisplay = current != null ? String(current) : null
          toDisplay = String(rawVal)

        } else if (def.fieldType === 'date') {
          const s = extractString(rawVal)
          if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) continue
          if (!isDifferentText(s, existing?.value?.valueDate ?? null)) continue
          parsedValue = s
          fromDisplay = existing?.value?.valueDate ?? null
          toDisplay = s

        } else if (def.fieldType === 'select') {
          const s = extractString(rawVal)
          if (!s) continue
          const opts = parseOptions(def)
          if (opts.length === 0) continue
          const matched = matchSelectOption(s, opts)
          if (!matched) continue
          if (!isDifferentText(matched, existing?.value?.valueText ?? null)) continue
          parsedValue = matched
          fromDisplay = existing?.value?.valueText ?? null
          toDisplay = matched

        } else if (def.fieldType === 'multiselect') {
          const rawArr = Array.isArray(rawVal)
            ? rawVal.map(String)
            : typeof rawVal === 'string' ? rawVal.split(',').map(s => s.trim()) : null
          if (!rawArr) continue
          const opts = parseOptions(def)
          if (opts.length === 0) continue
          const matched = rawArr.map(s => matchSelectOption(s, opts)).filter((m): m is string => m != null)
          if (matched.length === 0) continue
          const newJson = JSON.stringify(matched)
          if (newJson === (existing?.value?.valueText ?? null)) continue
          parsedValue = matched
          fromDisplay = existing?.value?.valueText ?? null
          toDisplay = matched.join(', ')
        }

        if (parsedValue == null) continue
        customFieldUpdates.push({
          fieldDefinitionId: def.id,
          label: def.label,
          fieldType: def.fieldType,
          newValue: parsedValue,
          fromDisplay,
          toDisplay,
        })
        changes.push({ field: def.label, from: fromDisplay, to: toDisplay })
      }
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
    if (updates.investmentStageFocus) existingSources.investmentStageFocus = meetingId
    if (updates.investmentSectorFocus) existingSources.investmentSectorFocus = meetingId

    if (Object.keys(existingSources).length > 0) {
      updates.fieldSources = JSON.stringify(existingSources)
    }

    proposals.push({
      contactId,
      contactName: contact.fullName,
      updates,
      companyLink,
      changes,
      customFieldUpdates: customFieldUpdates.length > 0 ? customFieldUpdates : undefined,
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
