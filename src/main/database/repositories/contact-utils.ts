/**
 * Pure utility functions for contact data normalization, parsing, and enrichment.
 * Extracted from contact.repo.ts so the repo file can focus on database operations.
 */

import { extractDomainFromEmail as extractCompanyDomainFromEmail } from '../../utils/company-extractor'
import type { ContactDuplicateSummary, ContactEmailParticipantRef } from '../../../shared/types/contact'

// ---------------------------------------------------------------------------
// Types shared between contact-utils and contact.repo
// ---------------------------------------------------------------------------

export interface CandidateContact {
  email: string
  fullName: string
  normalizedName: string
  explicitName: boolean
}

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

export function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^mailto:/, '')
  const cleaned = trimmed.replace(/^<+|>+$/g, '').replace(/[;,]+$/g, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

export function splitFullNameParts(fullName: string): { firstName: string | null; lastName: string | null } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length < 2) {
    return { firstName: null, lastName: null }
  }

  return {
    firstName: tokens[0] || null,
    lastName: tokens.slice(1).join(' ') || null
  }
}

export function inferNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || email
  const words = localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))

  return words.length > 0 ? words.join(' ') : email
}

export function sanitizeDisplayName(value: string): string | null {
  const trimmed = value.trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
  if (!trimmed) return null
  if (trimmed.toLowerCase() === 'unknown') return null
  if (normalizeEmail(trimmed)) return null
  return trimmed
}

// ---------------------------------------------------------------------------
// Attendee / participant parsing
// ---------------------------------------------------------------------------

export function parseAttendeeEntry(entry: string): {
  email: string | null
  fullName: string | null
  explicitName: boolean
} {
  const trimmed = entry.trim()
  if (!trimmed) {
    return { email: null, fullName: null, explicitName: false }
  }

  const angleMatch = trimmed.match(/^(.*?)\s*<([^<>]+)>$/)
  if (angleMatch) {
    const email = normalizeEmail(angleMatch[2] || '')
    const fullName = sanitizeDisplayName(angleMatch[1] || '')
    return { email, fullName, explicitName: Boolean(fullName) }
  }

  const parenMatch = trimmed.match(/^(.*?)\s*\(([^()]+)\)$/)
  if (parenMatch) {
    const email = normalizeEmail(parenMatch[2] || '')
    const fullName = sanitizeDisplayName(parenMatch[1] || '')
    if (email) {
      return { email, fullName, explicitName: Boolean(fullName) }
    }
  }

  const directEmail = normalizeEmail(trimmed)
  if (directEmail) {
    return { email: directEmail, fullName: null, explicitName: false }
  }

  return { email: null, fullName: sanitizeDisplayName(trimmed), explicitName: true }
}

export function mergeCandidate(
  existing: CandidateContact | undefined,
  incoming: CandidateContact
): CandidateContact {
  if (!existing) return incoming

  if (incoming.explicitName && !existing.explicitName) {
    return incoming
  }

  if (
    incoming.explicitName === existing.explicitName
    && incoming.fullName.length > existing.fullName.length
  ) {
    return incoming
  }

  return existing
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export function parseEmailParticipants(value: string | null): ContactEmailParticipantRef[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []

    const allowedRoles = new Set(['from', 'to', 'cc', 'bcc', 'reply_to'])
    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const candidate = item as Record<string, unknown>
        const role = typeof candidate.role === 'string' ? candidate.role.trim().toLowerCase() : ''
        const email = typeof candidate.email === 'string' ? candidate.email.trim().toLowerCase() : ''
        if (!allowedRoles.has(role) || !email) return null
        return {
          role: role as ContactEmailParticipantRef['role'],
          email,
          displayName: typeof candidate.displayName === 'string'
            ? candidate.displayName.trim() || null
            : null,
          contactId: typeof candidate.contactId === 'string'
            ? candidate.contactId.trim() || null
            : null
        }
      })
      .filter((item): item is ContactEmailParticipantRef => Boolean(item))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Timestamp utilities
// ---------------------------------------------------------------------------

export function normalizeForCompare(value: string | null | undefined): string {
  if (!value) return ''
  return value.trim().toLowerCase()
}

export const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

export function pickLatestTimestamp(values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null
  let latestTs = Number.NEGATIVE_INFINITY

  for (const value of values) {
    const ts = parseTimestamp(value)
    if (Number.isNaN(ts)) continue
    if (ts > latestTs) {
      latestTs = ts
      latestValue = value || null
    }
  }

  return latestValue
}

export function setLatestMapValue(
  map: Map<string, string>,
  key: string,
  candidate: string | null | undefined
): void {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return
  const latest = pickLatestTimestamp([map.get(normalizedKey) || null, candidate])
  if (latest) {
    map.set(normalizedKey, latest)
  }
}

// ---------------------------------------------------------------------------
// LinkedIn utilities
// ---------------------------------------------------------------------------

export const NAME_STOP_WORDS = new Set([
  'team',
  'support',
  'info',
  'hello',
  'noreply',
  'no-reply',
  'unknown',
  'meeting',
  'calendar'
])

export const LINKEDIN_URL_RE = /(?:https?:\/\/)?(?:www\.)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s<>"')]+/gi

export function normalizePersonNameCandidate(value: string | null | undefined): string | null {
  if (!value) return null
  let candidate = value
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')

  if (!candidate) return null
  if (normalizeEmail(candidate)) return null

  const commaSplit = candidate.match(/^([^,]{2,}),\s*(.{2,})$/)
  if (commaSplit) {
    candidate = `${commaSplit[2]} ${commaSplit[1]}`.trim()
  }

  candidate = candidate
    .replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, '')
    .replace(/[^A-Za-z0-9 .,'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!candidate) return null
  if (!/[A-Za-z]/.test(candidate)) return null
  if (/\d/.test(candidate)) return null

  const tokens = candidate
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length === 0) return null
  if (tokens.some((token) => NAME_STOP_WORDS.has(token.toLowerCase()))) return null

  return tokens.join(' ')
}

export function nameQualityScore(value: string): number {
  const candidate = normalizePersonNameCandidate(value)
  if (!candidate) return 0

  const tokens = candidate.split(/\s+/)
  let score = 0

  if (tokens.length >= 2) {
    score += 40
    score += Math.min(tokens.length, 4) * 5
  } else {
    score += 8
  }

  if (tokens.every((token) => /^[A-Za-z][A-Za-z.'-]*$/.test(token))) {
    score += 16
  }

  if (tokens.every((token) => token.length >= 2)) {
    score += 12
  }

  if (tokens.length === 1) {
    score -= 25
  }

  score += Math.min(candidate.length, 25)
  return score
}

export function isLikelyLowQualityStoredName(
  value: string | null | undefined,
  email: string | null
): boolean {
  const name = normalizePersonNameCandidate(value)
  if (!name) return true

  const tokens = name.split(/\s+/)
  if (tokens.length < 2) return true

  const normalizedEmail = normalizeEmail(email || '')
  if (normalizedEmail) {
    const inferred = normalizeName(inferNameFromEmail(normalizedEmail))
    if (normalizeName(name) === inferred) return true
  }

  return false
}

export function pickBestNameCandidate(
  candidates: string[],
  currentFullName: string | null | undefined,
  primaryEmail: string | null
): string | null {
  let best: { name: string; score: number } | null = null
  for (const candidateRaw of candidates) {
    const candidate = normalizePersonNameCandidate(candidateRaw)
    if (!candidate) continue
    const score = nameQualityScore(candidate)
    if (!best || score > best.score) {
      best = { name: candidate, score }
    }
  }

  if (!best) return null

  const currentScore = nameQualityScore(currentFullName || '')
  if (isLikelyLowQualityStoredName(currentFullName, primaryEmail)) {
    return best.score > 0 ? best.name : null
  }

  if (best.score >= currentScore + 12) {
    return best.name
  }

  return null
}

export function normalizeLinkedinUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (!/linkedin\.com/i.test(trimmed)) return null

  let normalized = trimmed.replace(/[)\].,;:!?]+$/, '')
  // Add https:// when the URL has no protocol (e.g. www.linkedin.com/in/... or linkedin.com/in/...)
  if (/^(?:www\.)?(?:[a-z]{2,3}\.)?linkedin\.com\//i.test(normalized)) {
    normalized = 'https://' + normalized
  }
  normalized = normalized.replace(/^http:\/\//i, 'https://')

  const queryIndex = normalized.indexOf('?')
  if (queryIndex > 0) {
    normalized = normalized.slice(0, queryIndex)
  }

  const hashIndex = normalized.indexOf('#')
  if (hashIndex > 0) {
    normalized = normalized.slice(0, hashIndex)
  }

  if (!/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/.+/i.test(normalized)) {
    return null
  }

  return normalized
}

export function extractLinkedinUrlsFromText(value: string | null | undefined): string[] {
  if (!value) return []
  const matches = value.match(LINKEDIN_URL_RE)
  if (!matches || matches.length === 0) return []
  const urls = new Set<string>()
  for (const match of matches) {
    const normalized = normalizeLinkedinUrl(match)
    if (normalized) urls.add(normalized)
  }
  return [...urls]
}

export function pickBestLinkedinUrl(
  existingUrl: string | null | undefined,
  candidates: string[]
): string | null {
  const existing = normalizeLinkedinUrl(existingUrl || '')
  const normalizedCandidates = [...new Set(
    candidates
      .map((candidate) => normalizeLinkedinUrl(candidate))
      .filter((candidate): candidate is string => Boolean(candidate))
  )]

  if (normalizedCandidates.length === 0) return null

  const rank = (url: string): number => {
    if (/\/in\//i.test(url)) return 3
    if (/\/pub\//i.test(url)) return 2
    if (/\/company\//i.test(url)) return 1
    return 0
  }

  const bestCandidate = normalizedCandidates.sort((a, b) => {
    const rankDiff = rank(b) - rank(a)
    if (rankDiff !== 0) return rankDiff
    return a.length - b.length
  })[0]

  if (!bestCandidate) return null
  if (!existing) return bestCandidate
  if (rank(bestCandidate) > rank(existing)) return bestCandidate
  return null
}

export function extractDomainFromEmail(value: string | null | undefined): string | null {
  if (!value) return null
  const normalizedEmail = normalizeEmail(value)
  if (!normalizedEmail) return null
  const inferred = extractCompanyDomainFromEmail(normalizedEmail)
  if (!inferred) return null
  return inferred.replace(/^www\./, '')
}

// ---------------------------------------------------------------------------
// Duplicate candidate comparison (pure sort function used in dedup logic)
// ---------------------------------------------------------------------------

export function compareDuplicateCandidates(
  a: ContactDuplicateSummary,
  b: ContactDuplicateSummary
): number {
  const completeness = (contact: ContactDuplicateSummary): number => {
    let score = 0
    if (contact.email) score += 3
    if (contact.primaryCompanyId) score += 2
    if (contact.title) score += 1
    const tokenCount = contact.fullName
      .trim()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean).length
    if (tokenCount >= 2) score += 1
    return score
  }

  const aScore = completeness(a)
  const bScore = completeness(b)
  if (aScore !== bScore) return bScore - aScore

  const aTs = parseTimestamp(a.updatedAt)
  const bTs = parseTimestamp(b.updatedAt)
  if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) {
    return bTs - aTs
  }

  return a.id.localeCompare(b.id)
}
