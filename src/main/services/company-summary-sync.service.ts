import * as companyRepo from '../database/repositories/org-company.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { resolveContactsByEmails } from '../database/repositories/contact.repo'
import { getContact } from '../database/repositories/contact.repo'
import { listFieldDefinitions, getFieldValuesForEntity } from '../database/repositories/custom-fields.repo'
import { normalizeWhitespace as _normalizeWhitespace, isDifferentText as _isDifferentText, stripMarkdown as _stripMarkdown } from '../utils/summary-text-utils'
import type { CompanyPipelineStage, CompanyRound, CompanySummary } from '../../shared/types/company'
import type {
  CompanySummaryUpdateChange,
  CompanySummaryUpdatePayload,
  CompanySummaryUpdateProposal,
  ContactTypeUpdateProposal,
  CustomFieldProposedUpdate
} from '../../shared/types/summary'
import type { LLMProvider } from '../llm/provider'
import type { CustomFieldDefinition } from '../../shared/types/custom-fields'
import { readSummary } from '../storage/file-manager'
import { safeParseJson, extractString, extractNumber } from '../utils/json-utils'

export interface MeetingContext {
  attendees: string[] | null
  attendeeEmails: string[] | null
}

interface ParsedVcSummaryFields {
  description: string | null
  round: CompanyRound | null
  raiseSize: number | null
  postMoneyValuation: number | null
  city: string | null
  state: string | null
  pipelineStage: CompanyPipelineStage | null
}

const SECTION_HEADER_HINTS = [
  'executive summary',
  'company overview',
  'key metrics',
  'traction',
  'team',
  'market opportunity',
  'the ask',
  'ask',
  'strengths',
  'concerns',
  'follow-ups',
  'follow ups',
  'action items'
]

const MONEY_FRAGMENT_RE = /\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:billion|bn|b|million|mm|m|thousand|k)?/i

const normalizeWhitespace = _normalizeWhitespace
const isDifferentText = _isDifferentText

function isDifferentNumber(next: number | null | undefined, current: number | null | undefined): boolean {
  if (next == null) return false
  if (current == null) return true
  return Math.abs(next - current) > 0.001
}

const stripMarkdown = _stripMarkdown

function normalizeHeaderLine(value: string): string {
  const plain = stripMarkdown(value)
    .replace(/^#{1,6}\s+/, '')
    .replace(/^\d+[\).\s-]+/, '')
    .trim()
    .toLowerCase()
  return normalizeWhitespace(plain)
}

function isLikelySectionHeader(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^#{1,6}\s+/.test(trimmed)) return true
  const normalized = normalizeHeaderLine(trimmed)
  if (!normalized) return false
  return SECTION_HEADER_HINTS.some((hint) => normalized.startsWith(hint))
}

function extractSection(summary: string, labels: string[]): string | null {
  const normalizedLabels = labels.map((label) => label.toLowerCase())
  const lines = summary.split(/\r?\n/)
  let startIndex = -1
  let inlineRemainder: string | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const normalized = normalizeHeaderLine(lines[i])
    if (!normalized) continue
    const matched = normalizedLabels.find((label) => normalized.startsWith(label))
    if (!matched) continue

    startIndex = i + 1

    const plain = stripMarkdown(lines[i])
      .replace(/^#{1,6}\s+/, '')
      .replace(/^\d+[\).\s-]+/, '')
      .trim()
    const plainLower = plain.toLowerCase()
    if (plainLower.startsWith(matched)) {
      const remainder = normalizeWhitespace(
        plain.slice(matched.length).replace(/^[:\-–—]\s*/, '')
      )
      inlineRemainder = remainder || null
    }
    break
  }

  if (startIndex < 0) return null

  const collected: string[] = []
  if (inlineRemainder) {
    collected.push(inlineRemainder)
  }

  for (let i = startIndex; i < lines.length; i += 1) {
    const raw = lines[i].trim()
    if (!raw) {
      if (collected.length > 0) break
      continue
    }

    if (isLikelySectionHeader(raw) && collected.length > 0) break

    const cleaned = normalizeWhitespace(stripMarkdown(raw))
    if (!cleaned) continue
    collected.push(cleaned)
    if (collected.join(' ').length > 700) break
  }

  if (collected.length === 0) return null
  return normalizeWhitespace(collected.join(' '))
}

function firstMeaningfulLine(summary: string): string | null {
  const lines = summary.split(/\r?\n/)
  for (const line of lines) {
    const cleaned = normalizeWhitespace(stripMarkdown(line))
    if (!cleaned) continue
    if (isLikelySectionHeader(line)) continue
    if (/^(n\/a|none|not provided)$/i.test(cleaned)) continue
    if (cleaned.length < 12) continue
    return cleaned
  }
  return null
}

function extractDescription(summary: string): string | null {
  const executive = extractSection(summary, ['executive summary'])
  const overview = extractSection(summary, ['company overview'])
  const source = executive || overview || firstMeaningfulLine(summary)
  if (!source) return null

  const cleaned = normalizeWhitespace(
    source.replace(/^((company overview)|(executive summary))\s*[:\-–—]\s*/i, '')
  )
  if (!cleaned || cleaned.length < 16) return null
  if (/what the company does, stage, and sector/i.test(cleaned)) return null

  const firstSentence = cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned
  const best = firstSentence.length >= 24 ? firstSentence : cleaned
  return best.length > 320 ? `${best.slice(0, 317)}...` : best
}

function parseRound(text: string): CompanyRound | null {
  const lower = text.toLowerCase()
  if (/\bpre[\s-]?seed\b/.test(lower)) return 'pre_seed'
  if (/\bseed\s*(extension|\+|plus)\b/.test(lower)) return 'seed_extension'
  if (/\bseries[\s-]?b\b/.test(lower)) return 'series_b'
  if (/\bseries[\s-]?a\b/.test(lower)) return 'series_a'
  if (/\bseed\b/.test(lower)) return 'seed'
  return null
}

function parseMoneyToMillions(raw: string): number | null {
  const compact = normalizeWhitespace(raw).toLowerCase()
  const match = compact.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(billion|bn|b|million|mm|m|thousand|k)?/)
  if (!match) return null

  const numeric = Number(match[1].replace(/,/g, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return null

  const unit = (match[2] || '').toLowerCase()
  let millions = numeric

  if (unit === 'billion' || unit === 'bn' || unit === 'b') {
    millions = numeric * 1000
  } else if (unit === 'million' || unit === 'mm' || unit === 'm') {
    millions = numeric
  } else if (unit === 'thousand' || unit === 'k') {
    millions = numeric / 1000
  } else {
    millions = numeric >= 1000 ? numeric / 1_000_000 : numeric
  }

  if (!Number.isFinite(millions) || millions <= 0 || millions > 200000) return null
  return Math.round(millions * 100) / 100
}

function findMoneyByLineKeys(text: string, keys: string[]): number | null {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (!keys.some((key) => lower.includes(key))) continue
    const moneyMatch = line.match(MONEY_FRAGMENT_RE)
    if (!moneyMatch?.[0]) continue
    const parsed = parseMoneyToMillions(moneyMatch[0])
    if (parsed != null) return parsed
  }
  return null
}

function extractRaiseSize(text: string): number | null {
  const byLine = findMoneyByLineKeys(text, [
    'raising',
    'seeking',
    'ask',
    'funding amount',
    'funding ask',
    'target raise',
    'round size'
  ])
  if (byLine != null) return byLine

  const pattern = /(?:raising|seeking|looking to raise|funding ask|ask is|ask:|targeting)\D{0,40}(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:billion|bn|b|million|mm|m|thousand|k)?)/i
  const match = text.match(pattern)
  if (!match?.[1]) return null
  return parseMoneyToMillions(match[1])
}

function extractPostMoneyValuation(text: string): number | null {
  const explicitPostMoney = findMoneyByLineKeys(text, [
    'post-money',
    'post money',
    'postmoney'
  ])
  if (explicitPostMoney != null) return explicitPostMoney

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const lower = line.toLowerCase()
    if (!lower.includes('valuation')) continue
    if (lower.includes('pre-money') || lower.includes('pre money')) continue
    const moneyMatch = line.match(MONEY_FRAGMENT_RE)
    if (!moneyMatch?.[0]) continue
    const parsed = parseMoneyToMillions(moneyMatch[0])
    if (parsed != null) return parsed
  }

  const pattern = /(?:post[-\s]?money(?: valuation)?|valued at|valuation(?: of)?)\D{0,40}(\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:billion|bn|b|million|mm|m|thousand|k)?)/i
  const match = text.match(pattern)
  if (!match?.[1]) return null
  return parseMoneyToMillions(match[1])
}

function extractLocation(text: string): { city: string | null; state: string | null } {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(
      /(?:based in|headquartered in|hq(?:'s)?(?: in)?|located in)\s+([A-Za-z][A-Za-z .'-]{1,60}),\s*([A-Za-z]{2})\b/i
    )
    if (!match) continue
    return {
      city: normalizeWhitespace(match[1]),
      state: match[2].toUpperCase()
    }
  }
  return { city: null, state: null }
}

function inferPipelineStage(text: string): CompanyPipelineStage | null {
  const lower = text.toLowerCase()
  if (/(not moving forward|passing|we should pass|decline this)/.test(lower)) return 'pass'
  if (/(term sheet|legal docs|closing docs|documentation)/.test(lower)) return 'documentation'
  if (/(move to diligence|begin diligence|next step[s]?:.*diligence|due diligence)/.test(lower)) return 'diligence'
  if (/(investment committee|ic review|partner decision|decision pending)/.test(lower)) return 'decision'
  return null
}

function extractFounderName(summary: string): string | null {
  const teamSection = extractSection(summary, ['team', 'founders', 'team / founders', 'team & founders'])
  if (!teamSection) return null

  // Look for patterns like "Founded by X", "CEO: X", "Founder: X", or just the first
  // capitalized multi-word name mentioned (likely a person name)
  const founderPatterns = [
    /(?:founded by|founder[s]?:?\s*|ceo[:\s]+)([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i,
    /([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*[\(,\-–—]\s*(?:founder|ceo|co-founder)/i
  ]

  for (const pattern of founderPatterns) {
    const match = teamSection.match(pattern)
    if (match?.[1]) return normalizeWhitespace(match[1])
  }

  return null
}

function matchFounderToAttendee(
  founderName: string | null,
  meetingContext: MeetingContext,
  companyId: string
): ContactTypeUpdateProposal | null {
  const attendees = meetingContext.attendees?.filter(Boolean) || []
  const attendeeEmails = meetingContext.attendeeEmails?.filter(Boolean) || []
  if (attendees.length === 0 || attendeeEmails.length === 0) return null

  // Resolve attendee emails to contact IDs
  const emailToContactId = resolveContactsByEmails(attendeeEmails)
  if (Object.keys(emailToContactId).length === 0) return null

  // Build pairs of (attendee name, contact ID)
  const candidates: Array<{ name: string; contactId: string }> = []
  for (let i = 0; i < attendees.length; i += 1) {
    const email = attendeeEmails[i]?.trim().toLowerCase()
    if (!email) continue
    const contactId = emailToContactId[email]
    if (!contactId) continue
    candidates.push({ name: attendees[i], contactId })
  }

  if (candidates.length === 0) return null

  // Try to match the extracted founder name against attendees
  let matched = candidates[0] // default to first external attendee
  if (founderName) {
    const lowerFounder = founderName.toLowerCase()
    const exactMatch = candidates.find((c) => c.name.toLowerCase() === lowerFounder)
    const partialMatch = candidates.find((c) => {
      const lowerName = c.name.toLowerCase()
      return lowerName.includes(lowerFounder) || lowerFounder.includes(lowerName)
    })
    if (exactMatch) {
      matched = exactMatch
    } else if (partialMatch) {
      matched = partialMatch
    }
  }

  // Verify contact exists and check current type
  const contact = getContact(matched.contactId)
  if (!contact) return null
  if (contact.contactType === 'founder') return null // already tagged

  // Verify contact is linked to the target company
  const isLinked = contact.primaryCompanyId === companyId
  if (!isLinked) return null

  return {
    contactId: contact.id,
    contactName: contact.fullName,
    fromType: contact.contactType,
    toType: 'founder'
  }
}

function parseVcPitchSummary(summary: string): ParsedVcSummaryFields {
  const executive = extractSection(summary, ['executive summary']) || ''
  const overview = extractSection(summary, ['company overview']) || ''
  const ask = extractSection(summary, ['the ask', 'ask']) || ''
  const combined = [executive, overview, ask, summary].filter(Boolean).join('\n')
  const location = extractLocation(combined)

  return {
    description: extractDescription(summary),
    round: parseRound(combined),
    raiseSize: extractRaiseSize(combined),
    postMoneyValuation: extractPostMoneyValuation(combined),
    city: location.city,
    state: location.state,
    pipelineStage: inferPipelineStage(combined)
  }
}

function isFirstMeetingForCompany(companyId: string, meetingId: string): boolean {
  const meetings = companyRepo.listCompanyMeetings(companyId)
  return meetings.length === 1 && meetings[0]?.id === meetingId
}

function selectTargetCompanies(companies: CompanySummary[], summary: string): CompanySummary[] {
  if (companies.length <= 1) return companies
  const lowerSummary = summary.toLowerCase()
  const explicitMatches = companies.filter((company) =>
    lowerSummary.includes(company.canonicalName.toLowerCase())
  )
  return explicitMatches.length === 1 ? explicitMatches : []
}

function buildProposalForCompany(
  company: CompanySummary,
  parsed: ParsedVcSummaryFields
): CompanySummaryUpdateProposal | null {
  const updates: CompanySummaryUpdatePayload = {}
  const changes: CompanySummaryUpdateChange[] = []

  if (isDifferentText(parsed.description, company.description)) {
    updates.description = parsed.description
    changes.push({ field: 'description', from: company.description, to: parsed.description })
  }
  if (parsed.round && parsed.round !== company.round) {
    updates.round = parsed.round
    changes.push({ field: 'round', from: company.round, to: parsed.round })
  }
  if (isDifferentNumber(parsed.raiseSize, company.raiseSize)) {
    updates.raiseSize = parsed.raiseSize
    changes.push({ field: 'raiseSize', from: company.raiseSize, to: parsed.raiseSize })
  }
  if (isDifferentNumber(parsed.postMoneyValuation, company.postMoneyValuation)) {
    updates.postMoneyValuation = parsed.postMoneyValuation
    changes.push({
      field: 'postMoneyValuation',
      from: company.postMoneyValuation,
      to: parsed.postMoneyValuation
    })
  }
  if (isDifferentText(parsed.city, company.city)) {
    updates.city = parsed.city
    changes.push({ field: 'city', from: company.city, to: parsed.city })
  }
  if (isDifferentText(parsed.state, company.state)) {
    updates.state = parsed.state
    changes.push({ field: 'state', from: company.state, to: parsed.state })
  }
  if (parsed.pipelineStage && parsed.pipelineStage !== company.pipelineStage) {
    updates.pipelineStage = parsed.pipelineStage
    changes.push({ field: 'pipelineStage', from: company.pipelineStage, to: parsed.pipelineStage })
  }

  if (changes.length === 0) return null
  return {
    companyId: company.id,
    companyName: company.canonicalName,
    updates,
    changes
  }
}

// ---------------------------------------------------------------------------
// Helpers shared with on-demand enrichment
// ---------------------------------------------------------------------------

function parseCustomOptions(def: CustomFieldDefinition): string[] {
  if (!def.optionsJson) return []
  try { return JSON.parse(def.optionsJson) } catch { return [] }
}

function buildCompanyCustomFieldPromptLines(defs: CustomFieldDefinition[]): string {
  return defs.map(def => {
    const base = `  "${def.fieldKey}" (${def.label})`
    if (def.fieldType === 'select' || def.fieldType === 'multiselect') {
      const opts = parseCustomOptions(def)
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

// Fuzzy select matching mirrored from contact-summary-sync
function matchCompanySelectOption(raw: string, options: string[]): string | null {
  const norm = raw.trim().toLowerCase()
  // exact match first
  const exact = options.find(o => o.toLowerCase() === norm)
  if (exact) return exact
  // prefix/contains fallback
  const partial = options.find(o => o.toLowerCase().includes(norm) || norm.includes(o.toLowerCase()))
  return partial ?? null
}

// ---------------------------------------------------------------------------
// On-demand company enrichment (Path 2 — batched LLM call)
// ---------------------------------------------------------------------------

/**
 * On-demand enrichment from CompanyDetail: takes multiple meeting IDs, reads
 * all their summaries, and makes ONE LLM call to extract company fields.
 *
 * Flow:
 *   meetingIds[] + companyId
 *       │
 *   Fetch meetings, read summary files (parallel, try/catch per file)
 *       │
 *   Filter to meetings that have summaries → if none: return null
 *       │
 *   getCompany(companyId) null check → return null
 *       │
 *   listFieldDefinitions('company') → filter !isBuiltin, !ref types
 *       │
 *   ONE LLM call (all summaries concatenated, labeled by date)
 *       │
 *   safeParseJson() → compare vs current company values
 *       │
 *   Build CompanySummaryUpdateProposal with changes + customFieldUpdates + fieldSources
 *       │
 *   return proposal if any changes, else null
 */
export async function getCompanyEnrichmentProposalsFromMeetings(
  meetingIds: string[],
  companyId: string,
  provider: LLMProvider
): Promise<CompanySummaryUpdateProposal | null> {
  try {
    if (meetingIds.length === 0 || !companyId) return null

    // Fetch meetings + read summaries in parallel
    const summaryEntries = await Promise.all(
      meetingIds.map(async (mid) => {
        try {
          const meeting = meetingRepo.getMeeting(mid)
          if (!meeting?.summaryFilename) return null
          const text = readSummary(meeting.summaryFilename)
          if (!text?.trim()) return null
          return { meetingId: mid, date: meeting.date ?? '', summary: text.trim() }
        } catch {
          return null
        }
      })
    )

    const validSummaries = summaryEntries.filter((e): e is NonNullable<typeof e> => e !== null)
    if (validSummaries.length === 0) return null

    const company = companyRepo.getCompany(companyId)
    if (!company) return null

    // Custom field defs for 'company' entity (skip builtins, refs, hidden)
    const customDefs = listFieldDefinitions('company').filter(
      d => !d.isBuiltin &&
           d.fieldType !== 'contact_ref' &&
           d.fieldType !== 'company_ref'
    )

    // Sort summaries oldest→newest (most recent last in prompt = more weight)
    const sorted = [...validSummaries].sort((a, b) => a.date.localeCompare(b.date))
    const summaryBlocks = sorted.map((e, i) =>
      `--- Meeting ${i + 1} (${e.date.slice(0, 10)}) ---\n${e.summary}`
    ).join('\n\n')

    const systemPrompt =
      'You are a company data extractor. Extract structured company information from ' +
      'meeting summaries. Return ONLY valid JSON — no prose, no markdown fences. ' +
      'For conflicting information across meetings, use the most recent value (meetings are in chronological order, last is most recent). ' +
      'Set fields to null if not mentioned in the summaries.'

    const builtinFields = [
      '  "description": one-sentence company description (string or null)',
      '  "round": funding round, one of [pre_seed, seed, seed_extension, series_a, series_b] or null',
      '  "raiseSize": raise size in millions USD (number or null)',
      '  "postMoneyValuation": post-money valuation in millions USD (number or null)',
      '  "city": headquarters city (string or null)',
      '  "state": headquarters state abbreviation (string or null)',
      '  "pipelineStage": one of [screening, diligence, decision, documentation, pass] or null',
    ].join('\n')

    const customFieldNotes = customDefs.length > 0
      ? `\n\nCustom fields to extract:\n${buildCompanyCustomFieldPromptLines(customDefs)}`
      : ''

    const userPrompt =
      `Extract information about company: ${company.canonicalName}\n\n` +
      `Meeting summaries:\n${summaryBlocks}\n\n` +
      `Return a JSON object with these fields:\n{\n${builtinFields}\n}` +
      customFieldNotes

    let responseText: string
    try {
      responseText = await provider.generateSummary(systemPrompt, userPrompt)
    } catch (err) {
      console.error('[Company Enrich] LLM call failed:', err)
      return null
    }

    const extracted = safeParseJson(responseText)
    if (!extracted) {
      console.warn('[Company Enrich] Could not parse LLM response as JSON')
      return null
    }

    // --- Built-in field comparison ---
    const updates: CompanySummaryUpdatePayload = {}
    const changes: CompanySummaryUpdateChange[] = []

    const rawDescription = extractString(extracted.description)
    if (rawDescription && isDifferentText(rawDescription, company.description)) {
      updates.description = rawDescription
      changes.push({ field: 'description', from: company.description, to: rawDescription })
    }

    const rawRound = extractString(extracted.round) as CompanyRound | null
    const validRounds: CompanyRound[] = ['pre_seed', 'seed', 'seed_extension', 'series_a', 'series_b']
    if (rawRound && validRounds.includes(rawRound) && rawRound !== company.round) {
      updates.round = rawRound
      changes.push({ field: 'round', from: company.round, to: rawRound })
    }

    const rawRaiseSize = extractNumber(extracted.raiseSize)
    if (isDifferentNumber(rawRaiseSize, company.raiseSize)) {
      updates.raiseSize = rawRaiseSize
      changes.push({ field: 'raiseSize', from: company.raiseSize, to: rawRaiseSize })
    }

    const rawPostMoney = extractNumber(extracted.postMoneyValuation)
    if (isDifferentNumber(rawPostMoney, company.postMoneyValuation)) {
      updates.postMoneyValuation = rawPostMoney
      changes.push({ field: 'postMoneyValuation', from: company.postMoneyValuation, to: rawPostMoney })
    }

    const rawCity = extractString(extracted.city)
    if (rawCity && isDifferentText(rawCity, company.city)) {
      updates.city = rawCity
      changes.push({ field: 'city', from: company.city, to: rawCity })
    }

    const rawState = extractString(extracted.state)
    if (rawState && isDifferentText(rawState, company.state)) {
      updates.state = rawState
      changes.push({ field: 'state', from: company.state, to: rawState })
    }

    const rawStage = extractString(extracted.pipelineStage) as CompanyPipelineStage | null
    const validStages: CompanyPipelineStage[] = ['screening', 'diligence', 'decision', 'documentation', 'pass']
    if (rawStage && validStages.includes(rawStage) && rawStage !== company.pipelineStage) {
      updates.pipelineStage = rawStage
      changes.push({ field: 'pipelineStage', from: company.pipelineStage, to: rawStage })
    }

    // --- Custom fields ---
    const customFieldUpdates: CustomFieldProposedUpdate[] = []

    if (customDefs.length > 0) {
      const currentValues = getFieldValuesForEntity('company', companyId)
      const currentValueMap = new Map(currentValues.map(v => [v.id, v]))

      for (const def of customDefs) {
        const rawVal = extracted[def.fieldKey]
        if (rawVal == null) continue

        let parsedValue: string | number | boolean | string[] | null = null
        let fromDisplay: string | null = null
        let toDisplay = ''

        const existing = currentValueMap.get(def.id)

        if (def.fieldType === 'text' || def.fieldType === 'url' || def.fieldType === 'textarea') {
          const s = extractString(rawVal)
          if (!s || !isDifferentText(s, existing?.value?.valueText ?? null)) continue
          parsedValue = s; fromDisplay = existing?.value?.valueText ?? null; toDisplay = s

        } else if (def.fieldType === 'number' || def.fieldType === 'currency') {
          const n = extractNumber(rawVal)
          if (n == null || n === (existing?.value?.valueNumber ?? null)) continue
          parsedValue = n; fromDisplay = existing?.value?.valueNumber != null ? String(existing.value.valueNumber) : null; toDisplay = String(n)

        } else if (def.fieldType === 'boolean') {
          if (typeof rawVal !== 'boolean') continue
          const current = existing?.value?.valueBoolean ?? null
          if (rawVal === current) continue
          parsedValue = rawVal; fromDisplay = current != null ? String(current) : null; toDisplay = String(rawVal)

        } else if (def.fieldType === 'date') {
          const s = extractString(rawVal)
          if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) continue
          if (!isDifferentText(s, existing?.value?.valueDate ?? null)) continue
          parsedValue = s; fromDisplay = existing?.value?.valueDate ?? null; toDisplay = s

        } else if (def.fieldType === 'select') {
          const s = extractString(rawVal)
          if (!s) continue
          const opts = parseCustomOptions(def)
          if (opts.length === 0) continue
          const matched = matchCompanySelectOption(s, opts)
          if (!matched || !isDifferentText(matched, existing?.value?.valueText ?? null)) continue
          parsedValue = matched; fromDisplay = existing?.value?.valueText ?? null; toDisplay = matched

        } else if (def.fieldType === 'multiselect') {
          const rawArr = Array.isArray(rawVal)
            ? rawVal.map(String)
            : typeof rawVal === 'string' ? rawVal.split(',').map(s => s.trim()) : null
          if (!rawArr) continue
          const opts = parseCustomOptions(def)
          if (opts.length === 0) continue
          const matched = rawArr.map(s => matchCompanySelectOption(s, opts)).filter((m): m is string => m != null)
          if (matched.length === 0) continue
          const newJson = JSON.stringify(matched)
          if (newJson === (existing?.value?.valueText ?? null)) continue
          parsedValue = matched; fromDisplay = existing?.value?.valueText ?? null; toDisplay = matched.join(', ')
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

    if (changes.length === 0) return null

    // Build fieldSources: use the most recent meeting ID for all applied built-in fields
    const mostRecentMeetingId = sorted[sorted.length - 1]!.meetingId
    const existingSources: Record<string, string> = {}
    if (company.fieldSources) {
      try {
        const prev = JSON.parse(company.fieldSources)
        if (prev && typeof prev === 'object') Object.assign(existingSources, prev)
      } catch { /* ignore */ }
    }
    for (const change of changes) {
      // Only track built-in fields (custom fields tracked separately in the UI)
      const builtinFieldNames = ['description', 'round', 'raiseSize', 'postMoneyValuation', 'city', 'state', 'pipelineStage']
      if (builtinFieldNames.includes(change.field)) {
        existingSources[change.field] = mostRecentMeetingId
      }
    }
    if (Object.keys(existingSources).length > 0) {
      updates.fieldSources = JSON.stringify(existingSources)
    }

    return {
      companyId: company.id,
      companyName: company.canonicalName,
      updates,
      changes,
      customFieldUpdates: customFieldUpdates.length > 0 ? customFieldUpdates : undefined,
    }
  } catch (err) {
    console.error('[Company Enrich] getCompanyEnrichmentProposalsFromMeetings failed:', err)
    return null
  }
}

export function getVcSummaryCompanyUpdateProposals(
  meetingId: string,
  summary: string,
  meetingContext?: MeetingContext
): CompanySummaryUpdateProposal[] {
  const trimmedSummary = summary.trim()
  if (!meetingId || !trimmedSummary) return []

  const linkedProspects = companyRepo
    .listMeetingCompanies(meetingId)
    .filter((company) => company.entityType === 'prospect')
    .filter((company) => isFirstMeetingForCompany(company.id, meetingId))

  if (linkedProspects.length === 0) return []

  const targets = selectTargetCompanies(linkedProspects, trimmedSummary)
  if (targets.length === 0) {
    console.log('[Company AutoFill] Skipped VC summary sync: ambiguous company target', {
      meetingId,
      candidates: linkedProspects.map((company) => company.canonicalName)
    })
    return []
  }

  const parsed = parseVcPitchSummary(trimmedSummary)
  const founderName = extractFounderName(trimmedSummary)

  const hasExtractedData = Boolean(
    parsed.description
    || parsed.round
    || parsed.raiseSize != null
    || parsed.postMoneyValuation != null
    || parsed.city
    || parsed.state
    || parsed.pipelineStage
    || founderName
  )

  if (!hasExtractedData) return []

  return targets
    .map((company) => {
      const proposal = buildProposalForCompany(company, parsed)
      // Attach founder update if meeting context is available
      let founderUpdate: ContactTypeUpdateProposal | null = null
      if (meetingContext) {
        try {
          founderUpdate = matchFounderToAttendee(founderName, meetingContext, company.id)
        } catch (err) {
          console.error('[Company AutoFill] Failed to match founder:', err)
        }
      }

      if (!proposal && !founderUpdate) return null
      return {
        companyId: company.id,
        companyName: company.canonicalName,
        updates: proposal?.updates || {},
        changes: proposal?.changes || [],
        founderUpdate
      } satisfies CompanySummaryUpdateProposal
    })
    .filter((proposal): proposal is CompanySummaryUpdateProposal => proposal !== null)
}
