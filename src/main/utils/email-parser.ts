/**
 * Shared email and name parsing utilities.
 * Extracted from company-email-ingest.service.ts so the ingest service can stay focused
 * on business logic (Gmail auth, query building, DB writes).
 */

export interface ParsedAddress {
  email: string
  displayName: string | null
}

// ---------------------------------------------------------------------------
// Email / domain normalization
// ---------------------------------------------------------------------------

export function normalizeEmail(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace(/^mailto:/, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

export function normalizeDomain(value: string): string | null {
  const cleaned = value.trim().toLowerCase().replace(/^www\./, '')
  if (!cleaned) return null
  return cleaned
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

export function normalizePersonName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function compactPersonName(value: string): string {
  return normalizePersonName(value).replace(/\s+/g, '')
}

export function splitFullNameParts(fullName: string): { firstName: string | null; lastName: string | null } {
  const tokens = fullName
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  if (tokens.length !== 2) {
    return { firstName: null, lastName: null }
  }

  return {
    firstName: tokens[0] || null,
    lastName: tokens[1] || null
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

export function sanitizeSenderDisplayName(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value
    .trim()
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (normalizeEmail(cleaned)) return null
  return cleaned
}

export function resolveContactName(displayName: string | null | undefined, email: string): string {
  return sanitizeSenderDisplayName(displayName) || inferNameFromEmail(email)
}

export function shouldPromoteContactName(existingName: string | null, candidateName: string): boolean {
  const existingNormalized = normalizePersonName(existingName || '')
  const candidateNormalized = normalizePersonName(candidateName)
  if (!candidateNormalized) return false
  if (!existingNormalized) return true
  if (candidateNormalized === existingNormalized) return false

  const existingCompact = compactPersonName(existingName || '')
  const candidateCompact = compactPersonName(candidateName)
  const existingTokenCount = existingNormalized.split(' ').filter(Boolean).length
  const candidateTokenCount = candidateNormalized.split(' ').filter(Boolean).length

  if (candidateTokenCount < existingTokenCount) return false

  const relatedByWordMatch = candidateNormalized.includes(existingNormalized)
    || existingNormalized.includes(candidateNormalized)
  const relatedByCompactMatch = candidateCompact === existingCompact
    || candidateCompact.includes(existingCompact)
    || existingCompact.includes(candidateCompact)

  if (!relatedByWordMatch && !relatedByCompactMatch && existingTokenCount >= 2) {
    return false
  }

  if (candidateTokenCount > existingTokenCount) return true
  return candidateNormalized.length > existingNormalized.length
}

export function selectExpandedContactName(
  currentFullName: string,
  senderNames: Set<string>
): string | null {
  const normalizedCurrent = normalizePersonName(currentFullName)
  const compactCurrent = compactPersonName(currentFullName)
  const currentTokenCount = normalizedCurrent.split(' ').filter(Boolean).length
  let selected: { raw: string; normalized: string } | null = null

  for (const senderName of senderNames) {
    const cleaned = sanitizeSenderDisplayName(senderName)
    if (!cleaned) continue

    const normalized = normalizePersonName(cleaned)
    const compact = compactPersonName(cleaned)
    if (!normalized || normalized === normalizedCurrent) continue

    const tokenCount = normalized.split(' ').filter(Boolean).length
    if (tokenCount < 2) continue

    if (normalizedCurrent) {
      const relatedByWordMatch = normalized.includes(normalizedCurrent)
      const relatedByCompactMatch = compactCurrent
        ? (compact === compactCurrent || compact.includes(compactCurrent))
        : false
      if (!relatedByWordMatch && !relatedByCompactMatch) continue

      const improvedByLength = normalized.length > normalizedCurrent.length
      const improvedByTokens = tokenCount > currentTokenCount
      if (!improvedByLength && !improvedByTokens) continue
    }

    if (!selected) {
      selected = { raw: cleaned, normalized }
      continue
    }

    if (normalized.length > selected.normalized.length) {
      selected = { raw: cleaned, normalized }
    }
  }

  return selected?.raw ?? null
}

// ---------------------------------------------------------------------------
// Domain extraction
// ---------------------------------------------------------------------------

export function extractDomainFromWebsiteUrl(websiteUrl: string | null): string | null {
  if (!websiteUrl) return null
  const trimmed = websiteUrl.trim()
  if (!trimmed) return null
  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    const url = new URL(withScheme)
    return normalizeDomain(url.hostname)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

function splitHeaderList(value: string): string[] {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((token) => token.trim())
    .filter(Boolean)
}

export function parseAddressToken(token: string): ParsedAddress | null {
  const trimmed = token.trim()
  if (!trimmed) return null

  const angle = trimmed.match(/^(.*?)<([^<>]+)>$/)
  if (angle) {
    const email = normalizeEmail(angle[2] || '')
    if (!email) return null
    const rawName = (angle[1] || '').trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
    return { email, displayName: rawName || null }
  }

  const directEmail = normalizeEmail(trimmed)
  if (directEmail) {
    return { email: directEmail, displayName: null }
  }

  const match = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  if (!match) return null
  const fallbackEmail = normalizeEmail(match[0] || '')
  if (!fallbackEmail) return null
  return { email: fallbackEmail, displayName: null }
}

export function parseAddressList(value: string | null): ParsedAddress[] {
  if (!value) return []
  const map = new Map<string, ParsedAddress>()
  for (const token of splitHeaderList(value)) {
    const parsed = parseAddressToken(token)
    if (!parsed) continue
    if (!map.has(parsed.email)) {
      map.set(parsed.email, parsed)
      continue
    }
    const existing = map.get(parsed.email)
    if (existing && !existing.displayName && parsed.displayName) {
      map.set(parsed.email, parsed)
    }
  }
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// Binary / HTML
// ---------------------------------------------------------------------------

export function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLength = (4 - (normalized.length % 4)) % 4
  const padded = normalized + '='.repeat(padLength)
  return Buffer.from(padded, 'base64').toString('utf-8')
}

export function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export function toIsoFromEpochMillis(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return null
  const date = new Date(ms)
  return date.toISOString()
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}
