import * as companyRepo from '../database/repositories/org-company.repo'
import type { CompanyPipelineStage, CompanyRound, CompanySummary } from '../../shared/types/company'

type CompanyUpdateInput = Parameters<typeof companyRepo.updateCompany>[1]

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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[\).]\s+/, '')
    .trim()
}

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

export function syncProspectCompaniesFromVcSummary(
  meetingId: string,
  summary: string,
  userId: string | null = null
): void {
  const trimmedSummary = summary.trim()
  if (!meetingId || !trimmedSummary) return

  const linkedProspects = companyRepo
    .listMeetingCompanies(meetingId)
    .filter((company) => company.entityType === 'prospect')
    .filter((company) => isFirstMeetingForCompany(company.id, meetingId))

  if (linkedProspects.length === 0) return

  const targets = selectTargetCompanies(linkedProspects, trimmedSummary)
  if (targets.length === 0) {
    console.log('[Company AutoFill] Skipped VC summary sync: ambiguous company target', {
      meetingId,
      candidates: linkedProspects.map((company) => company.canonicalName)
    })
    return
  }

  const parsed = parseVcPitchSummary(trimmedSummary)
  const hasExtractedData = Boolean(
    parsed.description
    || parsed.round
    || parsed.raiseSize != null
    || parsed.postMoneyValuation != null
    || parsed.city
    || parsed.state
    || parsed.pipelineStage
  )

  if (!hasExtractedData) return

  for (const company of targets) {
    const updates: CompanyUpdateInput = {}

    if (parsed.description && !company.description?.trim()) {
      updates.description = parsed.description
    }
    if (parsed.round && !company.round) {
      updates.round = parsed.round
    }
    if (parsed.raiseSize != null && company.raiseSize == null) {
      updates.raiseSize = parsed.raiseSize
    }
    if (parsed.postMoneyValuation != null && company.postMoneyValuation == null) {
      updates.postMoneyValuation = parsed.postMoneyValuation
    }
    if (parsed.city && !company.city) {
      updates.city = parsed.city
    }
    if (parsed.state && !company.state) {
      updates.state = parsed.state
    }
    if (parsed.pipelineStage && !company.pipelineStage) {
      updates.pipelineStage = parsed.pipelineStage
    }

    if (Object.keys(updates).length === 0) continue

    const updated = companyRepo.updateCompany(company.id, updates, userId)
    if (!updated) continue

    console.log('[Company AutoFill] Synced company fields from VC summary', {
      meetingId,
      companyId: company.id,
      companyName: company.canonicalName,
      updates
    })
  }
}
