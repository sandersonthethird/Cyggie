import * as companyRepo from '@cyggie/db/sqlite/repositories/org-company.repo'
import * as meetingRepo from '@cyggie/db/sqlite/repositories/meeting.repo'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'

const _companyNotesRepo = makeEntityNotesRepo('company_id')
import { resolveContactsByEmails } from '@cyggie/db/sqlite/repositories/contact.repo'
import { getContact } from '@cyggie/db/sqlite/repositories/contact.repo'
import { listFieldDefinitions, getFieldValuesForEntity } from '@cyggie/db/sqlite/repositories/custom-fields.repo'
import { normalizeWhitespace as _normalizeWhitespace, isDifferentText as _isDifferentText, stripMarkdown as _stripMarkdown } from '@main/utils/summary-text-utils'
import type { CompanyDetail, CompanyPipelineStage, CompanyRound, CompanySummary } from '@shared/types/company'
import { COMPANY_PIPELINE_STAGE_VALUES } from '@shared/types/company'
import type {
  CompanySummaryUpdateChange,
  CompanySummaryUpdatePayload,
  CompanySummaryUpdateProposal,
  ContactTypeUpdateProposal,
  CustomFieldProposedUpdate,
  EnrichmentResult
} from '@shared/types/summary'
import type { LLMProvider } from '@cyggie/services/llm/provider'
import type { CustomFieldDefinition } from '@shared/types/custom-fields'
import { readSummary } from '@main/storage/file-manager'
import { downloadSummaryFromDrive } from '@main/drive/google-drive'
import { safeParseJson, extractString, extractNumber } from '@main/utils/json-utils'
import { CANONICAL_INDUSTRIES, INDUSTRY_PROMPT_LIST, isCanonicalIndustry } from '@shared/constants/industries'
import { matchSelectOption } from './select-match'

export interface MeetingContext {
  attendees: string[] | null
  attendeeEmails: string[] | null
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
    const entry = emailToContactId[email]
    if (!entry) continue
    candidates.push({ name: attendees[i], contactId: entry.id })
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
/*
 * Core LLM extraction + diff engine, shared by meetings, notes, and email enrichment.
 *
 * Extraction pipeline:
 *   textBlocks ──▶ LLM prompt ──▶ safeParseJson ──▶ field diff ──▶ proposal
 *
 * fieldSourceId:
 *   string  → written to company.fieldSources for meeting-based attribution
 *   null    → skip fieldSources update (notes/email enrichment)
 */
export async function buildCompanyEnrichmentProposal(
  company: CompanyDetail,
  textBlocks: string,
  sourceLabel: string,
  customDefs: CustomFieldDefinition[],
  provider: LLMProvider,
  fieldSourceId: string | null
): Promise<EnrichmentResult> {
  const systemPrompt =
    'You are a company data extractor. Extract structured company information from ' +
    'the provided content. Return ONLY valid JSON — no prose, no markdown fences. ' +
    'For conflicting information, use the most recent value (content is in chronological order, last is most recent). ' +
    'Set fields to null if not mentioned in the content.\n\n' +
    'Return null unless the value is explicitly stated for the company being described. Specifically:\n' +
    '- round: only return the round currently being raised. Do not infer from comparable companies, prior rounds, or future plans. If the content describes a "seed" round, do not return "series_a" because a comp or competitor is at Series A.\n' +
    '- postMoneyValuation: only return a value if "post-money valuation" is explicitly stated for this company. Do not infer from market size, TAM, comparable company valuations, or pre-money figures.\n' +
    '- raiseSize: only return if the content explicitly states what this company is raising. Do not infer from comp deals or industry averages.\n' +
    '- industry/sector: an industry or sector classification (e.g. "LegalTech", "FinTech", "HealthTech") belongs ONLY in the "industry" field. Never put a sector value into "pipelineStage" or any custom field.\n' +
    '- custom fields: fill a custom field ONLY when the content explicitly states a value that matches that specific field\'s label/meaning. Do not place a value in a custom field merely because it is a plausible option there, and never cross-assign a stage/sector/round value between fields.\n\n' +
    'When in doubt, return null. False positives are worse than missing values.'

  const builtinFields = [
    '  "description": one-sentence company description (string or null)',
    '  "round": funding round, one of [pre_seed, seed, seed_extension, series_a, series_b] or null',
    '  "raiseSize": raise size in millions USD (number or null)',
    '  "postMoneyValuation": post-money valuation in millions USD (number or null)',
    '  "city": headquarters city (string or null)',
    '  "state": headquarters state abbreviation (string or null)',
    `  "pipelineStage": one of [${COMPANY_PIPELINE_STAGE_VALUES.join(', ')}] or null`,
    `  "industry": one of [${INDUSTRY_PROMPT_LIST}] or null (must be exact string match; null if no good fit)`,
  ].join('\n')

  const customFieldNotes = customDefs.length > 0
    ? `\n\nCustom fields to extract (fill each ONLY from content that explicitly matches that field's label; otherwise null — do not guess or cross-fill from another field's value):\n${buildCompanyCustomFieldPromptLines(customDefs)}`
    : ''

  const userPrompt =
    `Extract information about company: ${company.canonicalName}\n\n` +
    `${sourceLabel}:\n${textBlocks}\n\n` +
    `Return a JSON object with these fields:\n{\n${builtinFields}\n}` +
    customFieldNotes

  let responseText: string
  try {
    responseText = await provider.generateSummary(systemPrompt, userPrompt)
  } catch (err) {
    console.error('[Company Enrich] LLM call failed:', err)
    return { ok: false, reason: 'llm_failed' }
  }

  const extracted = safeParseJson(responseText)
  if (!extracted) {
    console.warn('[Company Enrich] Could not parse LLM response as JSON')
    return { ok: false, reason: 'parse_failed' }
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
  if (rawStage && COMPANY_PIPELINE_STAGE_VALUES.includes(rawStage) && rawStage !== company.pipelineStage) {
    updates.pipelineStage = rawStage
    changes.push({ field: 'pipelineStage', from: company.pipelineStage, to: rawStage })
  }

  // Industry — LLM-emitted value snapped to canonical list; non-canonical → NULL with warn-log.
  const rawIndustry = extractString(extracted.industry)
  if (rawIndustry !== null) {
    if (isCanonicalIndustry(rawIndustry)) {
      if (rawIndustry !== company.industry) {
        updates.industry = rawIndustry
        changes.push({ field: 'industry', from: company.industry, to: rawIndustry })
      }
    } else {
      console.warn(`[Company Enrich] Non-canonical industry "${rawIndustry}" returned by LLM — expected one of: ${CANONICAL_INDUSTRIES.join(', ')}. Dropping.`)
    }
  }

  // --- Custom fields ---
  const customFieldUpdates: CustomFieldProposedUpdate[] = []

  if (customDefs.length > 0) {
    const currentValues = getFieldValuesForEntity('company', company.id)
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
        const matched = matchSelectOption(s, opts)
        if (!matched || !isDifferentText(matched, existing?.value?.valueText ?? null)) continue
        parsedValue = matched; fromDisplay = existing?.value?.valueText ?? null; toDisplay = matched

      } else if (def.fieldType === 'multiselect') {
        const rawArr = Array.isArray(rawVal)
          ? rawVal.map(String)
          : typeof rawVal === 'string' ? rawVal.split(',').map(s => s.trim()) : null
        if (!rawArr) continue
        const opts = parseCustomOptions(def)
        if (opts.length === 0) continue
        const matched = rawArr.map(s => matchSelectOption(s, opts)).filter((m): m is string => m != null)
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
    }
  }

  // Empty changes → still ok:true so the UI can show "already up to date" instead
  // of the misleading "could not load enrichment" toast. No fieldSources to track
  // when there are no changes.
  if (changes.length === 0 && customFieldUpdates.length === 0) {
    return {
      ok: true,
      proposal: {
        companyId: company.id,
        companyName: company.canonicalName,
        updates: {},
        changes: [],
        customFieldUpdates: undefined,
      },
    }
  }

  // Only track fieldSources when a source ID is provided (skip for notes/email enrichment)
  if (fieldSourceId !== null) {
    const existingSources: Record<string, string> = {}
    if (company.fieldSources) {
      try {
        const prev = JSON.parse(company.fieldSources)
        if (prev && typeof prev === 'object') Object.assign(existingSources, prev)
      } catch { /* ignore */ }
    }
    // Only track built-in fields (custom fields tracked separately in the UI)
    const builtinFieldNames = ['description', 'round', 'raiseSize', 'postMoneyValuation', 'city', 'state', 'pipelineStage']
    for (const change of changes) {
      if (builtinFieldNames.includes(change.field)) {
        existingSources[change.field] = fieldSourceId
      }
    }
    if (Object.keys(existingSources).length > 0) {
      updates.fieldSources = JSON.stringify(existingSources)
    }
  }

  return {
    ok: true,
    proposal: {
      companyId: company.id,
      companyName: company.canonicalName,
      updates,
      changes,
      customFieldUpdates: customFieldUpdates.length > 0 ? customFieldUpdates : undefined,
    },
  }
}

export async function getCompanyEnrichmentProposalsFromMeetings(
  meetingIds: string[],
  companyId: string,
  provider: LLMProvider
): Promise<EnrichmentResult> {
  try {
    if (meetingIds.length === 0 || !companyId) return { ok: false, reason: 'no_content' }

    // Per-meeting content fetch: try local summary file → meeting.notes column →
    // Drive backup. First non-empty source wins.
    const contentEntries = await Promise.all(
      meetingIds.map(async (mid) => {
        try {
          const meeting = meetingRepo.getMeeting(mid)
          if (!meeting) return null

          let text: string | null = null
          if (meeting.summaryPath) text = readSummary(meeting.summaryPath)
          if (!text?.trim()) text = meeting.notes ?? null
          if (!text?.trim()) text = await downloadSummaryFromDrive(meeting.summaryDriveId ?? null)
          if (!text?.trim()) return null

          return { meetingId: mid, date: meeting.date ?? '', content: text.trim() }
        } catch {
          return null
        }
      })
    )

    const validContent = contentEntries.filter((e): e is NonNullable<typeof e> => e !== null)
    if (validContent.length === 0) return { ok: false, reason: 'no_content' }

    const company = companyRepo.getCompany(companyId)
    if (!company) return { ok: false, reason: 'company_not_found' }

    const customDefs = listFieldDefinitions('company').filter(
      d => !d.isBuiltin &&
           d.fieldType !== 'contact_ref' &&
           d.fieldType !== 'company_ref'
    )

    // Sort oldest→newest (most recent last in prompt = more weight)
    const sorted = [...validContent].sort((a, b) => a.date.localeCompare(b.date))
    const summaryBlocks = sorted.map((e, i) =>
      `--- Meeting ${i + 1} (${e.date.slice(0, 10)}) ---\n${e.content}`
    ).join('\n\n')

    const mostRecentMeetingId = sorted[sorted.length - 1]!.meetingId
    return await buildCompanyEnrichmentProposal(
      company, summaryBlocks, 'Meeting summaries', customDefs, provider, mostRecentMeetingId
    )
  } catch (err) {
    console.error('[Company Enrich] getCompanyEnrichmentProposalsFromMeetings failed:', err)
    return { ok: false, reason: 'llm_failed' }
  }
}

export async function getCompanyEnrichmentProposalsFromNotes(
  companyId: string,
  provider: LLMProvider
): Promise<EnrichmentResult> {
  try {
    if (!companyId) return { ok: false, reason: 'no_content' }

    const notes = _companyNotesRepo.list(companyId)
    const validNotes = notes.filter(n => n.content?.trim())
    if (validNotes.length === 0) return { ok: false, reason: 'no_content' }

    const company = companyRepo.getCompany(companyId)
    if (!company) return { ok: false, reason: 'company_not_found' }

    const customDefs = listFieldDefinitions('company').filter(
      d => !d.isBuiltin &&
           d.fieldType !== 'contact_ref' &&
           d.fieldType !== 'company_ref'
    )

    // Sort oldest→newest (most recent last = most weight in LLM)
    const sorted = [...validNotes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const noteBlocks = sorted.map((n, i) => {
      const label = n.title
        ? `${n.title} (${n.createdAt.slice(0, 10)})`
        : `Note ${i + 1} (${n.createdAt.slice(0, 10)})`
      return `--- ${label} ---\n${_stripMarkdown(n.content ?? '')}`
    }).join('\n\n')

    // null fieldSourceId = skip fieldSources tracking for note-based enrichment
    return await buildCompanyEnrichmentProposal(company, noteBlocks, 'Notes', customDefs, provider, null)
  } catch (err) {
    console.error('[Company Enrich Notes] getCompanyEnrichmentProposalsFromNotes failed:', err)
    return { ok: false, reason: 'llm_failed' }
  }
}

export async function getCompanyEnrichmentProposalsFromEmails(
  companyId: string,
  provider: LLMProvider
): Promise<EnrichmentResult> {
  try {
    if (!companyId) return { ok: false, reason: 'no_content' }

    const emails = companyRepo.listCompanyEmails(companyId)
    // Use snippet only; sort newest-first, cap at 30 to keep prompt size manageable
    const validEmails = emails
      .filter(e => e.snippet?.trim())
      .sort((a, b) => {
        const da = a.receivedAt ?? a.sentAt ?? ''
        const db = b.receivedAt ?? b.sentAt ?? ''
        return db.localeCompare(da)  // newest first
      })
      .slice(0, 30)
    if (validEmails.length === 0) return { ok: false, reason: 'no_content' }

    const company = companyRepo.getCompany(companyId)
    if (!company) return { ok: false, reason: 'company_not_found' }

    const customDefs = listFieldDefinitions('company').filter(
      d => !d.isBuiltin &&
           d.fieldType !== 'contact_ref' &&
           d.fieldType !== 'company_ref'
    )

    const emailBlocks = validEmails.map(e => {
      const date = (e.receivedAt ?? e.sentAt ?? '').slice(0, 10)
      const from = e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail
      const subj = e.subject?.trim() || '(no subject)'
      return `--- Email: "${subj}" from ${from} on ${date} ---\n${e.snippet!.trim()}`
    }).join('\n\n')

    // null fieldSourceId = skip fieldSources tracking for email-based enrichment
    return await buildCompanyEnrichmentProposal(company, emailBlocks, 'Emails', customDefs, provider, null)
  } catch (err) {
    console.error('[Company Enrich Emails] getCompanyEnrichmentProposalsFromEmails failed:', err)
    return { ok: false, reason: 'llm_failed' }
  }
}

export async function getVcSummaryCompanyUpdateProposals(
  meetingId: string,
  summary: string,
  meetingContext: MeetingContext | undefined,
  provider: LLMProvider
): Promise<CompanySummaryUpdateProposal[]> {
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

  const founderName = extractFounderName(trimmedSummary)
  const customDefs = listFieldDefinitions('company').filter(
    d => !d.isBuiltin &&
         d.fieldType !== 'contact_ref' &&
         d.fieldType !== 'company_ref'
  )

  const proposals = await Promise.all(
    targets.map(async (target) => {
      const company = companyRepo.getCompany(target.id)
      if (!company) return null

      let llmProposal: CompanySummaryUpdateProposal | null = null
      try {
        const result = await buildCompanyEnrichmentProposal(
          company, trimmedSummary, 'Meeting summary', customDefs, provider, meetingId
        )
        if (result.ok) llmProposal = result.proposal
        else console.log('[Company AutoFill] LLM extraction skipped:', { meetingId, companyId: company.id, reason: result.reason })
      } catch (err) {
        console.error('[Company AutoFill] LLM extraction threw:', err)
      }

      let founderUpdate: ContactTypeUpdateProposal | null = null
      if (meetingContext) {
        try {
          founderUpdate = matchFounderToAttendee(founderName, meetingContext, company.id)
        } catch (err) {
          console.error('[Company AutoFill] Failed to match founder:', err)
        }
      }

      const hasLlmChanges = !!llmProposal && (
        llmProposal.changes.length > 0 ||
        (llmProposal.customFieldUpdates?.length ?? 0) > 0
      )
      if (!hasLlmChanges && !founderUpdate) return null
      const proposal: CompanySummaryUpdateProposal = {
        companyId: company.id,
        companyName: company.canonicalName,
        updates: llmProposal?.updates ?? {},
        changes: llmProposal?.changes ?? [],
        founderUpdate
      }
      if (llmProposal?.customFieldUpdates) proposal.customFieldUpdates = llmProposal.customFieldUpdates
      return proposal
    })
  )

  return proposals.filter((p): p is CompanySummaryUpdateProposal => p !== null)
}
