import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import {
  createCompany as createOrgCompany,
  findCompanyIdByDomain,
  linkMeetingsForContactCompany
} from './org-company.repo'
import { extractDomainFromEmail as extractCompanyDomainFromEmail, humanizeDomainName } from '../../utils/company-extractor'
import type {
  ContactSummary,
  ContactSortBy,
  ContactSyncResult,
  ContactEnrichmentResult,
  ContactDetail,
  ContactMeetingRef,
  ContactEmailRef,
  ContactType
} from '../../../shared/types/contact'

interface ContactRow {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
  normalized_name: string
  email: string | null
  primary_company_id: string | null
  primary_company_name?: string | null
  title: string | null
  contact_type: string | null
  linkedin_url: string | null
  crm_contact_id: string | null
  crm_provider: string | null
  meeting_count?: number
  email_count?: number
  last_touchpoint?: string | null
  created_at: string
  updated_at: string
}

export interface ContactEmailOnboardingCandidate {
  id: string
  fullName: string
}

interface CandidateContact {
  email: string
  fullName: string
  normalizedName: string
  explicitName: boolean
}

interface ContactSyncStats {
  candidates: number
  inserted: number
  updated: number
  skipped: number
  invalid: number
}

interface MeetingAttendeeRow {
  id?: string
  title?: string
  date?: string
  status?: string
  duration_seconds?: number | null
  attendees: string | null
  attendee_emails: string | null
}

const VALID_CONTACT_TYPES = new Set<string>(['investor', 'founder', 'operator'])

function rowToContactSummary(row: ContactRow): ContactSummary {
  return {
    id: row.id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
    normalizedName: row.normalized_name,
    email: row.email,
    primaryCompanyId: row.primary_company_id,
    primaryCompanyName: row.primary_company_name ?? null,
    title: row.title,
    contactType: (row.contact_type && VALID_CONTACT_TYPES.has(row.contact_type)
      ? row.contact_type
      : null) as ContactType | null,
    linkedinUrl: row.linkedin_url,
    crmContactId: row.crm_contact_id,
    crmProvider: row.crm_provider,
    meetingCount: row.meeting_count || 0,
    emailCount: row.email_count || 0,
    lastTouchpoint: row.last_touchpoint ?? row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/^mailto:/, '')
  const cleaned = trimmed.replace(/^<+|>+$/g, '').replace(/[;,]+$/g, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function splitFullNameParts(fullName: string): { firstName: string | null; lastName: string | null } {
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

function inferNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] || email
  const words = localPart
    .split(/[._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))

  return words.length > 0 ? words.join(' ') : email
}

function sanitizeDisplayName(value: string): string | null {
  const trimmed = value.trim().replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '')
  if (!trimmed) return null
  if (trimmed.toLowerCase() === 'unknown') return null
  if (normalizeEmail(trimmed)) return null
  return trimmed
}

function parseAttendeeEntry(entry: string): {
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

function mergeCandidate(existing: CandidateContact | undefined, incoming: CandidateContact): CandidateContact {
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

function parseJsonArray(value: string | null): string[] {
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

function parseEmailParticipants(value: string | null): ContactEmailRef['participants'] {
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
          role: role as ContactEmailRef['participants'][number]['role'],
          email,
          displayName: typeof candidate.displayName === 'string'
            ? candidate.displayName.trim() || null
            : null,
          contactId: typeof candidate.contactId === 'string'
            ? candidate.contactId.trim() || null
            : null
        }
      })
      .filter((item): item is ContactEmailRef['participants'][number] => Boolean(item))
  } catch {
    return []
  }
}

function normalizeForCompare(value: string | null | undefined): string {
  if (!value) return ''
  return value.trim().toLowerCase()
}

const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

function pickLatestTimestamp(values: Array<string | null | undefined>): string | null {
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

const NAME_STOP_WORDS = new Set([
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

const LINKEDIN_URL_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s<>"')]+/gi

function normalizePersonNameCandidate(value: string | null | undefined): string | null {
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

function nameQualityScore(value: string): number {
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

function isLikelyLowQualityStoredName(value: string | null | undefined, email: string | null): boolean {
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

function pickBestNameCandidate(
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

function normalizeLinkedinUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  if (!/linkedin\.com/i.test(trimmed)) return null

  let normalized = trimmed.replace(/[)\].,;:!?]+$/, '')
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

function extractLinkedinUrlsFromText(value: string | null | undefined): string[] {
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

function pickBestLinkedinUrl(existingUrl: string | null | undefined, candidates: string[]): string | null {
  const existing = normalizeLinkedinUrl(existingUrl || '')
  const normalizedCandidates = [...new Set(candidates.map((candidate) => normalizeLinkedinUrl(candidate)).filter(
    (candidate): candidate is string => Boolean(candidate)
  ))]

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

function extractDomainFromEmail(value: string | null | undefined): string | null {
  if (!value) return null
  const normalizedEmail = normalizeEmail(value)
  if (!normalizedEmail) return null
  const inferred = extractCompanyDomainFromEmail(normalizedEmail)
  if (!inferred) return null
  return inferred.replace(/^www\./, '')
}

function ensurePrimaryCompanyLink(
  db: ReturnType<typeof getDatabase>,
  contactId: string,
  companyId: string,
  userId: string | null = null
): boolean {
  const updateResult = userId
    ? db.prepare(`
      UPDATE contacts
      SET primary_company_id = ?, updated_by_user_id = ?, updated_at = datetime('now')
      WHERE id = ? AND (primary_company_id IS NULL OR TRIM(primary_company_id) = '')
    `).run(companyId, userId, contactId)
    : db.prepare(`
      UPDATE contacts
      SET primary_company_id = ?, updated_at = datetime('now')
      WHERE id = ? AND (primary_company_id IS NULL OR TRIM(primary_company_id) = '')
    `).run(companyId, contactId)

  if (updateResult.changes > 0) {
    db.prepare(`
      INSERT INTO org_company_contacts (
        company_id, contact_id, is_primary, created_at
      )
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(company_id, contact_id) DO UPDATE SET
        is_primary = 1
    `).run(companyId, contactId)
  }

  return updateResult.changes > 0
}

function findCompanyIdByEmail(email: string | null | undefined): string | null {
  const domain = extractDomainFromEmail(email)
  if (!domain) return null
  return findCompanyIdByDomain(domain)
}

function inferCompanyIdFromEmails(
  emails: string[],
  userId: string | null = null,
  allowCreate = true
): string | null {
  for (const email of emails) {
    const existingCompanyId = findCompanyIdByEmail(email)
    if (existingCompanyId) return existingCompanyId
  }

  if (!allowCreate) return null

  for (const email of emails) {
    const domain = extractDomainFromEmail(email)
    if (!domain) continue

    const displayNameSeed = domain.split('.')[0] || domain
    const canonicalName = humanizeDomainName(displayNameSeed)
    if (!canonicalName.trim()) continue

    try {
      const created = createOrgCompany(
        {
          canonicalName,
          primaryDomain: domain,
          websiteUrl: `https://${domain}`,
          entityType: 'unknown',
          includeInCompaniesView: true,
          classificationSource: 'auto',
          classificationConfidence: 0.65
        },
        userId
      )
      if (created.id) return created.id
    } catch {
      // Continue trying other addresses/domains.
    }
  }

  return null
}

function listContactEmailAddresses(
  db: ReturnType<typeof getDatabase>,
  contactId: string,
  fallbackPrimaryEmail?: string | null
): string[] {
  const rows = db
    .prepare(`
      SELECT email
      FROM contact_emails
      WHERE contact_id = ?
      ORDER BY is_primary DESC, datetime(created_at) ASC, email ASC
    `)
    .all(contactId) as Array<{ email: string }>

  const emails = rows
    .map((row) => normalizeEmail(row.email))
    .filter((email): email is string => Boolean(email))

  const fallback = normalizeEmail(fallbackPrimaryEmail || '')
  if (fallback && !emails.includes(fallback)) {
    emails.unshift(fallback)
  }

  return [...new Set(emails)]
}

function attachEmailToContact(
  db: ReturnType<typeof getDatabase>,
  contactId: string,
  email: string,
  isPrimary: boolean
): void {
  db.prepare(`
    INSERT INTO contact_emails (contact_id, email, is_primary, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(contact_id, email) DO UPDATE SET
      is_primary = CASE
        WHEN excluded.is_primary = 1 THEN 1
        ELSE contact_emails.is_primary
      END
  `).run(contactId, email, isPrimary ? 1 : 0)
}

function collectEmailsFromAttendeeEntries(attendees: string[]): string[] {
  const emails = new Set<string>()
  for (const attendee of attendees) {
    const parsed = parseAttendeeEntry(attendee)
    if (parsed.email) {
      emails.add(parsed.email)
    }
  }
  return [...emails]
}

function buildCandidateMap(
  attendees: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined
): { candidates: CandidateContact[]; invalid: number } {
  const map = new Map<string, CandidateContact>()
  const attendeeList = attendees || []
  const attendeeEmailList = attendeeEmails || []
  let invalid = 0

  const addCandidate = (emailValue: string, nameValue: string | null, explicitName: boolean) => {
    const email = normalizeEmail(emailValue)
    if (!email) {
      invalid += 1
      return
    }

    const fullName = nameValue || inferNameFromEmail(email)
    const normalizedName = normalizeName(fullName)
    if (!normalizedName) {
      invalid += 1
      return
    }

    const incoming: CandidateContact = {
      email,
      fullName,
      normalizedName,
      explicitName
    }
    map.set(email, mergeCandidate(map.get(email), incoming))
  }

  for (let i = 0; i < attendeeEmailList.length; i += 1) {
    const emailEntry = attendeeEmailList[i]
    if (!emailEntry) continue
    const parsedAttendee = parseAttendeeEntry(attendeeList[i] || '')
    addCandidate(emailEntry, parsedAttendee.fullName, parsedAttendee.explicitName)
  }

  for (const attendee of attendeeList) {
    const parsed = parseAttendeeEntry(attendee)
    if (parsed.email) {
      addCandidate(parsed.email, parsed.fullName, parsed.explicitName)
    }
  }

  return {
    candidates: [...map.values()],
    invalid
  }
}

function applyCandidates(candidates: CandidateContact[], userId: string | null = null): ContactSyncStats {
  const db = getDatabase()
  const getByEmail = db.prepare(`
    SELECT c.id, c.full_name, c.first_name, c.last_name, c.normalized_name, c.email, c.primary_company_id
    FROM contacts c
    WHERE lower(c.email) = ?
      OR EXISTS (
        SELECT 1
        FROM contact_emails ce
        WHERE ce.contact_id = c.id AND lower(ce.email) = ?
      )
    LIMIT 1
  `)
  const insertContact = db.prepare(`
    INSERT INTO contacts (
      id, full_name, first_name, last_name, normalized_name, email, primary_company_id,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `)
  const updateContact = db.prepare(`
    UPDATE contacts
    SET
      full_name = ?,
      first_name = ?,
      last_name = ?,
      normalized_name = ?,
      updated_by_user_id = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `)
  const updateContactPrimaryEmail = db.prepare(`
    UPDATE contacts
    SET email = ?, updated_by_user_id = ?, updated_at = datetime('now')
    WHERE id = ? AND (email IS NULL OR TRIM(email) = '')
  `)

  const stats: ContactSyncStats = {
    candidates: candidates.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    invalid: 0
  }

  const upsertTransaction = db.transaction((items: CandidateContact[]) => {
    for (const candidate of items) {
      const existing = getByEmail.get(candidate.email, candidate.email) as {
        id: string
        full_name: string
        first_name: string | null
        last_name: string | null
        normalized_name: string
        email: string | null
        primary_company_id: string | null
      } | undefined

      if (!existing) {
        const contactId = randomUUID()
        const split = splitFullNameParts(candidate.fullName)
        const inferredCompanyId = findCompanyIdByEmail(candidate.email)
        insertContact.run(
          contactId,
          candidate.fullName,
          split.firstName,
          split.lastName,
          candidate.normalizedName,
          candidate.email,
          inferredCompanyId,
          userId,
          userId
        )
        attachEmailToContact(db, contactId, candidate.email, true)
        if (inferredCompanyId) {
          ensurePrimaryCompanyLink(db, contactId, inferredCompanyId, userId)
        }
        stats.inserted += 1
        continue
      }

      let nextName = existing.full_name
      let nextNormalized = existing.normalized_name

      if (candidate.explicitName && candidate.fullName !== existing.full_name) {
        nextName = candidate.fullName
        nextNormalized = candidate.normalizedName
      } else if (!existing.full_name.trim() || !existing.normalized_name) {
        nextName = candidate.fullName
        nextNormalized = candidate.normalizedName
      }

      const split = splitFullNameParts(nextName)
      if (
        nextName !== existing.full_name
        || nextNormalized !== existing.normalized_name
        || split.firstName !== existing.first_name
        || split.lastName !== existing.last_name
      ) {
        updateContact.run(nextName, split.firstName, split.lastName, nextNormalized, userId, existing.id)
        stats.updated += 1
      } else {
        stats.skipped += 1
      }

      if (!existing.email || !existing.email.trim()) {
        updateContactPrimaryEmail.run(candidate.email, userId, existing.id)
      }
      attachEmailToContact(
        db,
        existing.id,
        candidate.email,
        !existing.email || normalizeEmail(existing.email || '') === candidate.email
      )

      if (!existing.primary_company_id) {
        const inferredCompanyId = findCompanyIdByEmail(candidate.email)
        if (inferredCompanyId) {
          ensurePrimaryCompanyLink(db, existing.id, inferredCompanyId, userId)
        }
      }
    }
  })

  upsertTransaction(candidates)
  return stats
}

function buildContactOrderBy(sortBy: ContactSortBy | undefined, includeLastTouchpoint: boolean): string {
  if (sortBy === 'first_name') {
    return `
      ORDER BY
        lower(COALESCE(NULLIF(trim(c.first_name), ''), c.full_name)) ASC,
        lower(COALESCE(NULLIF(trim(c.last_name), ''), c.full_name)) ASC,
        lower(c.full_name) ASC,
        lower(COALESCE(c.email, '')) ASC
    `
  }

  if (sortBy === 'last_name') {
    return `
      ORDER BY
        lower(COALESCE(NULLIF(trim(c.last_name), ''), c.full_name)) ASC,
        lower(COALESCE(NULLIF(trim(c.first_name), ''), c.full_name)) ASC,
        lower(c.full_name) ASC,
        lower(COALESCE(c.email, '')) ASC
    `
  }

  if (sortBy === 'company') {
    return `
      ORDER BY
        CASE
          WHEN oc.canonical_name IS NULL OR trim(oc.canonical_name) = '' THEN 1
          ELSE 0
        END ASC,
        lower(COALESCE(oc.canonical_name, '')) ASC,
        lower(c.full_name) ASC,
        lower(COALESCE(c.email, '')) ASC
    `
  }

  if (includeLastTouchpoint) {
    return `
      ORDER BY datetime(last_touchpoint) DESC, c.full_name ASC, c.email ASC
    `
  }

  return `
    ORDER BY datetime(c.updated_at) DESC, c.full_name ASC, c.email ASC
  `
}

function setLatestMapValue(map: Map<string, string>, key: string, candidate: string | null | undefined): void {
  const normalizedKey = key.trim().toLowerCase()
  if (!normalizedKey) return
  const latest = pickLatestTimestamp([map.get(normalizedKey) || null, candidate])
  if (latest) {
    map.set(normalizedKey, latest)
  }
}

function buildContactEmailMap(
  db: ReturnType<typeof getDatabase>,
  rows: ContactRow[]
): Map<string, string[]> {
  const contactIds = rows.map((row) => row.id).filter((value) => value.trim().length > 0)
  const byContact = new Map<string, Set<string>>()

  for (const row of rows) {
    const contactId = row.id.trim()
    if (!contactId) continue
    if (!byContact.has(contactId)) {
      byContact.set(contactId, new Set<string>())
    }
    const normalized = normalizeEmail(row.email || '')
    if (normalized) {
      byContact.get(contactId)!.add(normalized)
    }
  }

  if (contactIds.length === 0) {
    return new Map()
  }

  const placeholders = contactIds.map(() => '?').join(', ')
  const emailRows = db
    .prepare(`
      SELECT contact_id, email
      FROM contact_emails
      WHERE contact_id IN (${placeholders})
    `)
    .all(...contactIds) as Array<{
    contact_id: string
    email: string | null
  }>

  for (const row of emailRows) {
    const contactId = row.contact_id.trim()
    if (!contactId) continue
    if (!byContact.has(contactId)) {
      byContact.set(contactId, new Set<string>())
    }
    const normalized = normalizeEmail(row.email || '')
    if (normalized) {
      byContact.get(contactId)!.add(normalized)
    }
  }

  const result = new Map<string, string[]>()
  for (const [contactId, emails] of byContact.entries()) {
    result.set(contactId, [...emails])
  }
  return result
}

function buildLatestMeetingTouchByEmail(
  db: ReturnType<typeof getDatabase>
): Map<string, string> {
  const rows = db
    .prepare(`
      SELECT date, attendees, attendee_emails
      FROM meetings
      WHERE (attendee_emails IS NOT NULL OR attendees IS NOT NULL)
        AND date IS NOT NULL
    `)
    .all() as Array<{
    date: string | null
    attendees: string | null
    attendee_emails: string | null
  }>

  const latestByEmail = new Map<string, string>()
  for (const row of rows) {
    const meetingDate = row.date
    if (!meetingDate) continue

    for (const rawEmail of parseJsonArray(row.attendee_emails)) {
      const email = normalizeEmail(rawEmail)
      if (!email) continue
      setLatestMapValue(latestByEmail, email, meetingDate)
    }

    for (const entry of parseJsonArray(row.attendees)) {
      const parsed = parseAttendeeEntry(entry)
      if (!parsed.email) continue
      setLatestMapValue(latestByEmail, parsed.email, meetingDate)
    }
  }
  return latestByEmail
}

function buildLatestEmailTouchByEmail(
  db: ReturnType<typeof getDatabase>
): Map<string, string> {
  const rows = db
    .prepare(`
      SELECT
        email,
        MAX(last_at) AS last_touchpoint
      FROM (
        SELECT
          lower(trim(p.email)) AS email,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS last_at
        FROM email_message_participants p
        JOIN email_messages em ON em.id = p.message_id
        WHERE p.email IS NOT NULL
          AND trim(p.email) <> ''

        UNION ALL

        SELECT
          lower(trim(em.from_email)) AS email,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS last_at
        FROM email_messages em
        WHERE em.from_email IS NOT NULL
          AND trim(em.from_email) <> ''
      ) source
      WHERE source.last_at IS NOT NULL
      GROUP BY email
    `)
    .all() as Array<{
    email: string
    last_touchpoint: string | null
  }>

  const latestByEmail = new Map<string, string>()
  for (const row of rows) {
    if (!row.email) continue
    setLatestMapValue(latestByEmail, row.email, row.last_touchpoint)
  }
  return latestByEmail
}

function buildLatestEmailTouchByContactId(
  db: ReturnType<typeof getDatabase>,
  contactIds: string[]
): Map<string, string> {
  if (contactIds.length === 0) return new Map()
  const placeholders = contactIds.map(() => '?').join(', ')
  const rows = db
    .prepare(`
      SELECT
        contact_id,
        MAX(last_at) AS last_touchpoint
      FROM (
        SELECT
          l.contact_id AS contact_id,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS last_at
        FROM email_contact_links l
        JOIN email_messages em ON em.id = l.message_id
        WHERE l.contact_id IN (${placeholders})

        UNION ALL

        SELECT
          p.contact_id AS contact_id,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS last_at
        FROM email_message_participants p
        JOIN email_messages em ON em.id = p.message_id
        WHERE p.contact_id IN (${placeholders})
      ) source
      WHERE source.contact_id IS NOT NULL
      GROUP BY contact_id
    `)
    .all(...contactIds, ...contactIds) as Array<{
    contact_id: string
    last_touchpoint: string | null
  }>

  const latestByContactId = new Map<string, string>()
  for (const row of rows) {
    if (!row.contact_id) continue
    setLatestMapValue(latestByContactId, row.contact_id, row.last_touchpoint)
  }
  return latestByContactId
}

function applyActivityTouchpointToContactRows(
  db: ReturnType<typeof getDatabase>,
  rows: ContactRow[]
): ContactRow[] {
  if (rows.length === 0) return rows

  const contactIds = rows.map((row) => row.id).filter((value) => value.trim().length > 0)
  const emailsByContactId = buildContactEmailMap(db, rows)
  const latestMeetingByEmail = buildLatestMeetingTouchByEmail(db)
  const latestEmailByEmail = buildLatestEmailTouchByEmail(db)
  const latestEmailByContactId = buildLatestEmailTouchByContactId(db, contactIds)

  return rows.map((row) => {
    const contactId = row.id.trim()
    const candidates: Array<string | null | undefined> = [latestEmailByContactId.get(contactId.toLowerCase())]

    const emails = emailsByContactId.get(contactId) || []
    for (const email of emails) {
      candidates.push(latestMeetingByEmail.get(email))
      candidates.push(latestEmailByEmail.get(email))
    }

    const computed = pickLatestTimestamp(candidates)
    return {
      ...row,
      last_touchpoint: computed || row.updated_at
    }
  })
}

export function listContacts(filter?: {
  query?: string
  limit?: number
  offset?: number
  sortBy?: ContactSortBy
}): ContactSummary[] {
  const db = getDatabase()
  const query = filter?.query?.trim()
  const params: unknown[] = []
  const conditions: string[] = ['c.email IS NOT NULL']

  if (query) {
    conditions.push('(c.full_name LIKE ? OR c.email LIKE ?)')
    const like = `%${query}%`
    params.push(like, like)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filter?.limit ?? 200
  const offset = filter?.offset ?? 0

  const rows = db
    .prepare(`
      WITH meeting_stats AS (
        SELECT
          c.id AS contact_id,
          COUNT(DISTINCT m.id) AS meeting_count,
          MAX(m.date) AS last_meeting_at
        FROM contacts c
        JOIN contact_emails ce ON ce.contact_id = c.id
        JOIN meetings m ON EXISTS (
          SELECT 1
          FROM json_each(COALESCE(m.attendee_emails, '[]')) e
          WHERE lower(trim(e.value)) = lower(trim(ce.email))
        )
        GROUP BY c.id
      ),
      email_stats AS (
        SELECT
          c.id AS contact_id,
          COUNT(DISTINCT p.message_id) AS email_count,
          MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
        FROM contacts c
        JOIN contact_emails ce ON ce.contact_id = c.id
        JOIN email_message_participants p ON lower(trim(p.email)) = lower(trim(ce.email))
        JOIN email_messages em ON em.id = p.message_id
        GROUP BY c.id
      )
      SELECT
        c.id,
        c.full_name,
        c.first_name,
        c.last_name,
        c.normalized_name,
        c.email,
        c.primary_company_id,
        oc.canonical_name AS primary_company_name,
        c.title,
        c.contact_type,
        c.linkedin_url,
        c.crm_contact_id,
        c.crm_provider,
        COALESCE(ms.meeting_count, 0) AS meeting_count,
        COALESCE(es.email_count, 0) AS email_count,
        COALESCE(
          CASE
            WHEN ms.last_meeting_at IS NULL THEN es.last_email_at
            WHEN es.last_email_at IS NULL THEN ms.last_meeting_at
            WHEN ms.last_meeting_at > es.last_email_at THEN ms.last_meeting_at
            ELSE es.last_email_at
          END,
          c.updated_at
        ) AS last_touchpoint,
        c.created_at,
        c.updated_at
      FROM contacts c
      LEFT JOIN meeting_stats ms ON ms.contact_id = c.id
      LEFT JOIN email_stats es ON es.contact_id = c.id
      LEFT JOIN org_companies oc ON oc.id = c.primary_company_id
      ${where}
      ${buildContactOrderBy(filter?.sortBy, true)}
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as ContactRow[]

  return rows.map(rowToContactSummary)
}

export function listContactsLight(filter?: {
  query?: string
  limit?: number
  offset?: number
  sortBy?: ContactSortBy
  includeActivityTouchpoint?: boolean
}): ContactSummary[] {
  const db = getDatabase()
  const query = filter?.query?.trim()
  const params: unknown[] = []
  const conditions: string[] = ['c.email IS NOT NULL']

  if (query) {
    conditions.push('(c.full_name LIKE ? OR c.email LIKE ?)')
    const like = `%${query}%`
    params.push(like, like)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filter?.limit ?? 200
  const offset = filter?.offset ?? 0
  const includeActivityTouchpoint = filter?.includeActivityTouchpoint === true

  const baseRows = db
    .prepare(`
      SELECT
        c.id,
        c.full_name,
        c.first_name,
        c.last_name,
        c.normalized_name,
        c.email,
        c.primary_company_id,
        oc.canonical_name AS primary_company_name,
        c.title,
        c.contact_type,
        c.linkedin_url,
        c.crm_contact_id,
        c.crm_provider,
        0 AS meeting_count,
        0 AS email_count,
        c.updated_at AS last_touchpoint,
        c.created_at,
        c.updated_at
      FROM contacts c
      LEFT JOIN org_companies oc ON oc.id = c.primary_company_id
      ${where}
      ${buildContactOrderBy(filter?.sortBy, false)}
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as ContactRow[]

  const rows = includeActivityTouchpoint
    ? applyActivityTouchpointToContactRows(db, baseRows)
    : baseRows

  return rows.map(rowToContactSummary)
}

export function listContactsForEmailOnboarding(limit = 5000): ContactEmailOnboardingCandidate[] {
  const db = getDatabase()
  const safeLimit = Math.max(1, Math.min(limit, 10000))

  const rows = db
    .prepare(`
      SELECT
        c.id,
        c.full_name
      FROM contacts c
      WHERE
        (c.email IS NOT NULL AND TRIM(c.email) <> '')
        OR EXISTS (
          SELECT 1
          FROM contact_emails ce
          WHERE ce.contact_id = c.id
            AND ce.email IS NOT NULL
            AND TRIM(ce.email) <> ''
        )
      ORDER BY datetime(c.updated_at) DESC, c.id ASC
      LIMIT ?
    `)
    .all(safeLimit) as Array<{ id: string; full_name: string | null }>

  return rows.map((row) => ({
    id: row.id,
    fullName: (row.full_name || 'Unknown contact').trim() || 'Unknown contact'
  }))
}

export function hasContactEmailHistory(contactId: string): boolean {
  const normalizedContactId = contactId.trim()
  if (!normalizedContactId) return false

  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, email
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `)
    .get(normalizedContactId) as { id: string; email: string | null } | undefined
  if (!row) return false

  const normalizedEmails = listContactEmailAddresses(db, normalizedContactId, row.email)
  if (normalizedEmails.length === 0) return false

  const placeholders = normalizedEmails.map(() => '?').join(', ')
  const match = db
    .prepare(`
      SELECT 1 AS has_history
      WHERE EXISTS (
        SELECT 1
        FROM email_contact_links l
        WHERE l.contact_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM email_message_participants p
        WHERE p.contact_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM email_message_participants p
        WHERE lower(trim(p.email)) IN (${placeholders})
      )
      OR EXISTS (
        SELECT 1
        FROM email_messages em
        WHERE lower(trim(em.from_email)) IN (${placeholders})
      )
      LIMIT 1
    `)
    .get(normalizedContactId, normalizedContactId, ...normalizedEmails, ...normalizedEmails) as {
    has_history: number
  } | undefined

  return Boolean(match?.has_history)
}

export function createContact(data: {
  fullName: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  title?: string | null
  contactType?: string | null
  linkedinUrl?: string | null
}, userId: string | null = null): ContactSummary {
  const db = getDatabase()
  const providedFirstName = (data.firstName || '').trim()
  const providedLastName = (data.lastName || '').trim()
  const explicitName = [providedFirstName, providedLastName].filter(Boolean).join(' ').trim()
  const fullName = (explicitName || data.fullName || '').trim()
  if (!fullName) {
    throw new Error('Contact name is required')
  }

  const email = data.email ? normalizeEmail(data.email) : null
  const inferredCompanyId = email ? findCompanyIdByEmail(email) : null

  const normalizedName = normalizeName(fullName)
  const splitName = explicitName
    ? {
      firstName: providedFirstName || null,
      lastName: providedLastName || null
    }
    : splitFullNameParts(fullName)
  const selectById = db.prepare(`
    SELECT
      id,
      full_name,
      first_name,
      last_name,
      normalized_name,
      email,
      primary_company_id,
      title,
      contact_type,
      linkedin_url,
      crm_contact_id,
      crm_provider,
      created_at,
      updated_at
    FROM contacts
    WHERE id = ?
    LIMIT 1
  `)

  const existing = email
    ? db
      .prepare(`
        SELECT
          c.id,
          c.full_name,
          c.first_name,
          c.last_name,
          c.normalized_name,
          c.email,
          c.primary_company_id,
          c.title,
          c.contact_type,
          c.linkedin_url,
          c.crm_contact_id,
          c.crm_provider,
          c.created_at,
          c.updated_at
        FROM contacts c
        WHERE lower(c.email) = ?
          OR EXISTS (
            SELECT 1
            FROM contact_emails ce
            WHERE ce.contact_id = c.id AND lower(ce.email) = ?
          )
        LIMIT 1
      `)
      .get(email, email) as ContactRow | undefined
    : undefined

  let contactId = existing?.id || null

  if (!contactId) {
    contactId = randomUUID()
    db.prepare(`
      INSERT INTO contacts (
        id, full_name, first_name, last_name, normalized_name, email, primary_company_id,
        title, contact_type, linkedin_url, created_by_user_id, updated_by_user_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      contactId,
      fullName,
      splitName.firstName,
      splitName.lastName,
      normalizedName,
      email,
      inferredCompanyId,
      data.title?.trim() || null,
      data.contactType?.trim() || null,
      data.linkedinUrl?.trim() || null,
      userId,
      userId
    )
    if (email) attachEmailToContact(db, contactId, email, true)
    if (inferredCompanyId) {
      ensurePrimaryCompanyLink(db, contactId, inferredCompanyId, userId)
    }
  } else {
    if (userId) {
      db.prepare(`
        UPDATE contacts
        SET
          full_name = ?,
          first_name = ?,
          last_name = ?,
          normalized_name = ?,
          title = COALESCE(?, title),
          email = COALESCE(NULLIF(TRIM(email), ''), ?),
          updated_by_user_id = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        fullName,
        splitName.firstName,
        splitName.lastName,
        normalizedName,
        data.title?.trim() || null,
        email,
        userId,
        contactId
      )
    } else {
      db.prepare(`
        UPDATE contacts
        SET
          full_name = ?,
          first_name = ?,
          last_name = ?,
          normalized_name = ?,
          title = COALESCE(?, title),
          email = COALESCE(NULLIF(TRIM(email), ''), ?),
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        fullName,
        splitName.firstName,
        splitName.lastName,
        normalizedName,
        data.title?.trim() || null,
        email,
        contactId
      )
    }

    const primaryEmail = normalizeEmail(existing?.email || '')
    attachEmailToContact(db, contactId, email, !primaryEmail || primaryEmail === email)
    if (!existing.primary_company_id && inferredCompanyId) {
      ensurePrimaryCompanyLink(db, contactId, inferredCompanyId, userId)
    }
  }

  const row = selectById.get(contactId) as ContactRow | undefined

  if (!row) {
    throw new Error('Failed to create or load contact')
  }

  return rowToContactSummary(row)
}

export function updateContact(
  contactId: string,
  data: {
    fullName?: string
    firstName?: string | null
    lastName?: string | null
    title?: string | null
    contactType?: string | null
    linkedinUrl?: string | null
  },
  userId: string | null = null
): ContactDetail {
  const db = getDatabase()

  const existing = db
    .prepare(`SELECT id, full_name, first_name, last_name FROM contacts WHERE id = ? LIMIT 1`)
    .get(contactId) as { id: string; full_name: string; first_name: string | null; last_name: string | null } | undefined
  if (!existing) {
    throw new Error('Contact not found')
  }

  const sets: string[] = []
  const params: unknown[] = []

  if (data.fullName !== undefined) {
    const fullName = data.fullName.trim()
    if (!fullName) throw new Error('Contact name is required')
    const normalizedName = normalizeName(fullName)
    const split = splitFullNameParts(fullName)
    sets.push('full_name = ?', 'normalized_name = ?', 'first_name = ?', 'last_name = ?')
    params.push(fullName, normalizedName, split.firstName, split.lastName)
  } else {
    if (data.firstName !== undefined || data.lastName !== undefined) {
      const firstName = data.firstName !== undefined ? data.firstName : existing.first_name
      const lastName = data.lastName !== undefined ? data.lastName : existing.last_name
      const fullName = [firstName, lastName].filter(Boolean).join(' ').trim() || existing.full_name
      sets.push('full_name = ?', 'normalized_name = ?', 'first_name = ?', 'last_name = ?')
      params.push(fullName, normalizeName(fullName), firstName || null, lastName || null)
    }
  }

  if (data.title !== undefined) {
    sets.push('title = ?')
    params.push(data.title?.trim() || null)
  }

  if (data.contactType !== undefined) {
    const ct = data.contactType?.trim() || null
    if (ct && !VALID_CONTACT_TYPES.has(ct)) {
      throw new Error(`Invalid contact type: ${ct}`)
    }
    sets.push('contact_type = ?')
    params.push(ct)
  }

  if (data.linkedinUrl !== undefined) {
    sets.push('linkedin_url = ?')
    params.push(data.linkedinUrl?.trim() || null)
  }

  if (sets.length === 0) {
    const detail = getContact(contactId)
    if (!detail) throw new Error('Contact not found')
    return detail
  }

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(contactId)

  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...params)

  const detail = getContact(contactId)
  if (!detail) throw new Error('Failed to load updated contact')
  return detail
}

export function addContactEmail(
  contactId: string,
  emailInput: string,
  userId: string | null = null
): ContactDetail {
  const db = getDatabase()
  const email = normalizeEmail(emailInput)
  if (!email) {
    throw new Error('Valid contact email is required')
  }

  const contact = db
    .prepare(`
      SELECT id, email, primary_company_id
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `)
    .get(contactId) as { id: string; email: string | null; primary_company_id: string | null } | undefined
  if (!contact) {
    throw new Error('Contact not found')
  }

  const existingOwner = db
    .prepare(`
      SELECT contact_id
      FROM contact_emails
      WHERE lower(email) = ?
      LIMIT 1
    `)
    .get(email) as { contact_id: string } | undefined
  if (existingOwner && existingOwner.contact_id !== contactId) {
    throw new Error('Email is already linked to another contact')
  }

  const currentPrimaryEmail = normalizeEmail(contact.email || '')
  const shouldBePrimary = !currentPrimaryEmail || currentPrimaryEmail === email

  const tx = db.transaction(() => {
    if (!currentPrimaryEmail) {
      if (userId) {
        db.prepare(`
          UPDATE contacts
          SET email = ?, updated_by_user_id = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(email, userId, contactId)
      } else {
        db.prepare(`
          UPDATE contacts
          SET email = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(email, contactId)
      }
    }
    attachEmailToContact(db, contactId, email, shouldBePrimary)
    if (!contact.primary_company_id) {
      const inferredCompanyId = findCompanyIdByEmail(email)
      if (inferredCompanyId) {
        ensurePrimaryCompanyLink(db, contactId, inferredCompanyId, userId)
      }
    }
  })
  tx()

  const updated = getContact(contactId)
  if (!updated) {
    throw new Error('Failed to load updated contact')
  }
  return updated
}

export function setContactPrimaryCompany(
  contactId: string,
  companyId: string | null,
  userId: string | null = null
): ContactDetail {
  const db = getDatabase()

  const contact = db
    .prepare(`
      SELECT id
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `)
    .get(contactId) as { id: string } | undefined

  if (!contact) {
    throw new Error('Contact not found')
  }

  if (companyId) {
    const company = db
      .prepare(`
        SELECT id
        FROM org_companies
        WHERE id = ?
        LIMIT 1
      `)
      .get(companyId) as { id: string } | undefined
    if (!company) {
      throw new Error('Company not found')
    }
  }

  const updatePrimaryCompany = userId
    ? db.prepare(`
      UPDATE contacts
      SET primary_company_id = ?, updated_by_user_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
    : db.prepare(`
      UPDATE contacts
      SET primary_company_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `)
  const deleteAllLinksForContact = db.prepare(`
    DELETE FROM org_company_contacts
    WHERE contact_id = ?
  `)
  const deleteOtherLinksForContact = db.prepare(`
    DELETE FROM org_company_contacts
    WHERE contact_id = ? AND company_id <> ?
  `)
  const upsertCompanyContactLink = db.prepare(`
    INSERT INTO org_company_contacts (
      company_id, contact_id, is_primary, created_at
    )
    VALUES (?, ?, 1, datetime('now'))
    ON CONFLICT(company_id, contact_id) DO UPDATE SET
      is_primary = 1
  `)

  const tx = db.transaction((nextCompanyId: string | null) => {
    if (userId) {
      updatePrimaryCompany.run(nextCompanyId, userId, contactId)
    } else {
      updatePrimaryCompany.run(nextCompanyId, contactId)
    }
    if (!nextCompanyId) {
      deleteAllLinksForContact.run(contactId)
      return
    }

    deleteOtherLinksForContact.run(contactId, nextCompanyId)
    upsertCompanyContactLink.run(nextCompanyId, contactId)
  })

  tx(companyId)

  // Backfill meeting-company links for meetings where this contact is an attendee
  if (companyId) {
    const emails = db
      .prepare(`SELECT email FROM contact_emails WHERE contact_id = ?`)
      .all(contactId) as Array<{ email: string }>
    const contactEmails = emails.map((e) => e.email)
    if (contactEmails.length > 0) {
      linkMeetingsForContactCompany(companyId, contactEmails, userId)
    }
  }

  const updated = getContact(contactId)
  if (!updated) {
    throw new Error('Failed to load updated contact')
  }
  return updated
}

function getContactEmailActivity(
  db: ReturnType<typeof getDatabase>,
  contactId: string,
  normalizedEmails: string[]
): { emailCount: number; lastEmailAt: string | null } {
  if (!contactId.trim()) return { emailCount: 0, lastEmailAt: null }

  if (normalizedEmails.length === 0) {
    const row = db
      .prepare(`
        SELECT
          COUNT(DISTINCT em.id) AS email_count,
          MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
        FROM email_messages em
        WHERE EXISTS (
          SELECT 1
          FROM email_contact_links l
          WHERE l.message_id = em.id
            AND l.contact_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM email_message_participants p
          WHERE p.message_id = em.id
            AND p.contact_id = ?
        )
      `)
      .get(contactId, contactId) as { email_count: number | null; last_email_at: string | null } | undefined
    return {
      emailCount: Number(row?.email_count || 0),
      lastEmailAt: row?.last_email_at ?? null
    }
  }

  const placeholders = normalizedEmails.map(() => '?').join(', ')
  const row = db
    .prepare(`
      SELECT
        COUNT(DISTINCT em.id) AS email_count,
        MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
      FROM email_messages em
      WHERE EXISTS (
        SELECT 1
        FROM email_contact_links l
        WHERE l.message_id = em.id
          AND l.contact_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM email_message_participants p
        WHERE p.message_id = em.id
          AND (
            p.contact_id = ?
            OR lower(trim(p.email)) IN (${placeholders})
          )
      )
      OR lower(trim(em.from_email)) IN (${placeholders})
    `)
    .get(contactId, contactId, ...normalizedEmails, ...normalizedEmails) as {
      email_count: number | null
      last_email_at: string | null
    } | undefined

  return {
    emailCount: Number(row?.email_count || 0),
    lastEmailAt: row?.last_email_at ?? null
  }
}

export function getContact(contactId: string): ContactDetail | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        c.id,
        c.full_name,
        c.first_name,
        c.last_name,
        c.normalized_name,
        c.email,
        c.primary_company_id,
        c.title,
        c.contact_type,
        c.linkedin_url,
        c.crm_contact_id,
        c.crm_provider,
        c.created_at,
        c.updated_at,
        oc.canonical_name AS primary_company_name,
        oc.primary_domain AS primary_company_domain,
        oc.website_url AS primary_company_website_url
      FROM contacts c
      LEFT JOIN org_companies oc ON oc.id = c.primary_company_id
      WHERE c.id = ?
      LIMIT 1
    `)
    .get(contactId) as (ContactRow & {
    primary_company_name: string | null
    primary_company_domain: string | null
    primary_company_website_url: string | null
  }) | undefined

  if (!row) return null

  const summary = rowToContactSummary(row)
  const contactEmails = listContactEmailAddresses(db, contactId, row.email)
  const normalizedEmailSet = new Set(
    contactEmails
      .map((value) => normalizeForCompare(value))
      .filter((value) => Boolean(value))
  )
  let meetings: ContactMeetingRef[] = []
  let lastMeetingAt: string | null = null

  if (normalizedEmailSet.size > 0) {
    const meetingRows = db
      .prepare(`
        SELECT
          id,
          title,
          date,
          status,
          duration_seconds,
          attendees,
          attendee_emails
        FROM meetings
        WHERE attendee_emails IS NOT NULL OR attendees IS NOT NULL
        ORDER BY datetime(date) DESC
      `)
      .all() as MeetingAttendeeRow[]

    meetings = meetingRows
      .filter((meeting) => {
        const attendeeEmails = parseJsonArray(meeting.attendee_emails).map(normalizeForCompare)
        if (attendeeEmails.some((email) => normalizedEmailSet.has(email))) return true

        const attendeeEntries = parseJsonArray(meeting.attendees)
        const attendeeDerivedEmails = collectEmailsFromAttendeeEntries(attendeeEntries)
          .map(normalizeForCompare)
        return attendeeDerivedEmails.some((email) => normalizedEmailSet.has(email))
      })
      .map((meeting) => ({
        id: meeting.id || '',
        title: meeting.title || 'Untitled meeting',
        date: meeting.date || '',
        status: meeting.status || 'unknown',
        durationSeconds: meeting.duration_seconds ?? null
      }))
      .filter((meeting) => Boolean(meeting.id))

    if (meetings.length > 0) {
      lastMeetingAt = pickLatestTimestamp(meetings.map((meeting) => meeting.date))
    }
  }

  const normalizedEmails = [...normalizedEmailSet]
  const emailActivity = getContactEmailActivity(db, contactId, normalizedEmails)
  const computedLastTouchpoint = pickLatestTimestamp([lastMeetingAt, emailActivity.lastEmailAt]) || row.updated_at
  summary.meetingCount = meetings.length
  summary.emailCount = emailActivity.emailCount
  summary.lastTouchpoint = computedLastTouchpoint

  return {
    ...summary,
    primaryCompany: row.primary_company_id && row.primary_company_name
      ? {
        id: row.primary_company_id,
        canonicalName: row.primary_company_name,
        primaryDomain: row.primary_company_domain ?? null,
        websiteUrl: row.primary_company_website_url ?? null
      }
      : null,
    emails: contactEmails,
    meetings
  }
}

export function listContactEmails(contactId: string): ContactEmailRef[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      WITH linked AS (
        SELECT
          em.id,
          em.subject,
          em.from_email,
          em.from_name,
          em.received_at,
          em.sent_at,
          em.snippet,
          em.body_text,
          em.is_unread,
          em.thread_id,
          em.updated_at,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS sort_at,
          COALESCE(em.thread_id, em.id) AS thread_group
        FROM email_messages em
        WHERE EXISTS (
          SELECT 1
          FROM email_contact_links l
          WHERE l.message_id = em.id AND l.contact_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM email_message_participants p
          WHERE p.message_id = em.id AND p.contact_id = ?
        )
      ),
      ranked AS (
        SELECT
          id,
          subject,
          from_email,
          from_name,
          received_at,
          sent_at,
          snippet,
          body_text,
          is_unread,
          thread_id,
          sort_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_group
            ORDER BY datetime(sort_at) DESC, datetime(updated_at) DESC, id DESC
          ) AS row_num,
          COUNT(*) OVER (PARTITION BY thread_group) AS thread_message_count
        FROM linked
      ),
      participant_rows AS (
        SELECT
          p.message_id,
          p.role,
          LOWER(p.email) AS email,
          COALESCE(NULLIF(TRIM(p.display_name), ''), NULLIF(TRIM(c.full_name), '')) AS display_name,
          p.contact_id
        FROM email_message_participants p
        LEFT JOIN contacts c ON c.id = p.contact_id
      ),
      participants AS (
        SELECT
          source.message_id,
          json_group_array(
            json_object(
              'role', source.role,
              'email', source.email,
              'displayName', source.display_name,
              'contactId', source.contact_id
            )
          ) AS participants_json
        FROM (
          SELECT
            message_id,
            role,
            email,
            display_name,
            contact_id
          FROM participant_rows
          ORDER BY
            message_id,
            CASE role
              WHEN 'from' THEN 0
              WHEN 'to' THEN 1
              WHEN 'cc' THEN 2
              WHEN 'bcc' THEN 3
              WHEN 'reply_to' THEN 4
              ELSE 5
            END,
            email
        ) source
        GROUP BY source.message_id
      )
      SELECT
        ranked.id,
        ranked.subject,
        ranked.from_email,
        ranked.from_name,
        ranked.received_at,
        ranked.sent_at,
        ranked.snippet,
        ranked.body_text,
        ranked.is_unread,
        ranked.thread_id,
        ranked.thread_message_count,
        COALESCE(participants.participants_json, '[]') AS participants_json
      FROM ranked
      LEFT JOIN participants ON participants.message_id = ranked.id
      WHERE ranked.row_num = 1
      ORDER BY datetime(ranked.sort_at) DESC, ranked.id DESC
      LIMIT 200
    `)
    .all(contactId, contactId) as Array<{
    id: string
    subject: string | null
    from_email: string
    from_name: string | null
    received_at: string | null
    sent_at: string | null
    snippet: string | null
    body_text: string | null
    is_unread: number
    thread_id: string | null
    thread_message_count: number
    participants_json: string
  }>

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    fromEmail: row.from_email,
    fromName: row.from_name,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    snippet: row.snippet,
    bodyText: row.body_text,
    isUnread: row.is_unread === 1,
    threadId: row.thread_id,
    threadMessageCount: row.thread_message_count || 1,
    participants: parseEmailParticipants(row.participants_json)
  }))
}

export function autoLinkContactsByDomain(limit = 5000, userId: string | null = null): number {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, email
      FROM contacts
      WHERE primary_company_id IS NULL OR TRIM(primary_company_id) = ''
      ORDER BY datetime(updated_at) DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string
    email: string | null
  }>

  let linked = 0
  for (const row of rows) {
    const emails = listContactEmailAddresses(db, row.id, row.email)
    let companyId: string | null = null
    for (const email of emails) {
      companyId = findCompanyIdByEmail(email)
      if (companyId) break
    }
    if (!companyId) continue
    if (ensurePrimaryCompanyLink(db, row.id, companyId, userId)) {
      linked += 1
    }
  }

  return linked
}

export function syncContactsFromAttendees(
  attendees: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined,
  userId: string | null = null
): ContactSyncStats {
  const { candidates, invalid } = buildCandidateMap(attendees, attendeeEmails)
  const result = applyCandidates(candidates, userId)
  autoLinkContactsByDomain(5000, userId)
  return {
    ...result,
    invalid
  }
}

export function syncContactsFromMeetings(userId: string | null = null): ContactSyncResult {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT attendees, attendee_emails
      FROM meetings
      WHERE attendees IS NOT NULL OR attendee_emails IS NOT NULL
    `)
    .all() as MeetingAttendeeRow[]

  const mergedMap = new Map<string, CandidateContact>()
  let invalid = 0

  for (const row of rows) {
    const attendees = parseJsonArray(row.attendees)
    const attendeeEmails = parseJsonArray(row.attendee_emails)
    const rowCandidates = buildCandidateMap(attendees, attendeeEmails)
    invalid += rowCandidates.invalid
    for (const candidate of rowCandidates.candidates) {
      mergedMap.set(candidate.email, mergeCandidate(mergedMap.get(candidate.email), candidate))
    }
  }

  const result = applyCandidates([...mergedMap.values()], userId)
  autoLinkContactsByDomain(5000, userId)
  return {
    scannedMeetings: rows.length,
    candidates: result.candidates,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    invalid
  }
}

function buildMeetingEnrichmentIndexes(
  db: ReturnType<typeof getDatabase>
): {
  nameCandidatesByEmail: Map<string, Set<string>>
  companyHitsByEmail: Map<string, Map<string, number>>
} {
  const meetingRows = db
    .prepare(`
      SELECT id, attendees, attendee_emails
      FROM meetings
      WHERE attendees IS NOT NULL OR attendee_emails IS NOT NULL
      ORDER BY datetime(date) DESC
    `)
    .all() as MeetingAttendeeRow[]

  const meetingCompanyRows = db
    .prepare(`
      SELECT meeting_id, company_id
      FROM meeting_company_links
    `)
    .all() as Array<{ meeting_id: string; company_id: string }>

  const companiesByMeeting = new Map<string, string[]>()
  for (const row of meetingCompanyRows) {
    const meetingId = (row.meeting_id || '').trim()
    const companyId = (row.company_id || '').trim()
    if (!meetingId || !companyId) continue
    const existing = companiesByMeeting.get(meetingId)
    if (existing) {
      if (!existing.includes(companyId)) existing.push(companyId)
    } else {
      companiesByMeeting.set(meetingId, [companyId])
    }
  }

  const nameCandidatesByEmail = new Map<string, Set<string>>()
  const companyHitsByEmail = new Map<string, Map<string, number>>()

  const addNameCandidate = (email: string, candidateName: string | null) => {
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || !candidateName) return
    const normalizedNameCandidate = normalizePersonNameCandidate(candidateName)
    if (!normalizedNameCandidate) return

    const existing = nameCandidatesByEmail.get(normalizedEmail)
    if (existing) {
      existing.add(normalizedNameCandidate)
    } else {
      nameCandidatesByEmail.set(normalizedEmail, new Set([normalizedNameCandidate]))
    }
  }

  const addCompanyHits = (email: string, companyIds: string[]) => {
    const normalizedEmail = normalizeEmail(email)
    if (!normalizedEmail || companyIds.length === 0) return

    let hitMap = companyHitsByEmail.get(normalizedEmail)
    if (!hitMap) {
      hitMap = new Map<string, number>()
      companyHitsByEmail.set(normalizedEmail, hitMap)
    }

    for (const companyId of companyIds) {
      hitMap.set(companyId, (hitMap.get(companyId) || 0) + 1)
    }
  }

  for (const meeting of meetingRows) {
    const attendeeEntries = parseJsonArray(meeting.attendees)
    const attendeeEmails = parseJsonArray(meeting.attendee_emails)
      .map((value) => normalizeEmail(value))
      .filter((value): value is string => Boolean(value))
    const meetingCompanies = companiesByMeeting.get(meeting.id || '') || []

    const pairCount = Math.min(attendeeEntries.length, attendeeEmails.length)
    for (let i = 0; i < pairCount; i += 1) {
      const email = attendeeEmails[i]
      if (!email) continue
      const attendeeRaw = attendeeEntries[i] || ''
      const parsed = parseAttendeeEntry(attendeeRaw)
      addNameCandidate(email, parsed.fullName || attendeeRaw)
      addCompanyHits(email, meetingCompanies)
    }

    for (const attendeeRaw of attendeeEntries) {
      const parsed = parseAttendeeEntry(attendeeRaw)
      if (!parsed.email) continue
      addNameCandidate(parsed.email, parsed.fullName)
      addCompanyHits(parsed.email, meetingCompanies)
    }
  }

  return {
    nameCandidatesByEmail,
    companyHitsByEmail
  }
}

interface ContactEnrichmentCandidate {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
  email: string | null
  primary_company_id: string | null
  linkedin_url: string | null
}

function enrichContactCandidates(
  db: ReturnType<typeof getDatabase>,
  contacts: ContactEnrichmentCandidate[],
  userId: string | null = null
): ContactEnrichmentResult {
  const { nameCandidatesByEmail, companyHitsByEmail } = buildMeetingEnrichmentIndexes(db)

  const updateName = userId
    ? db.prepare(`
      UPDATE contacts
      SET
        full_name = ?,
        first_name = ?,
        last_name = ?,
        normalized_name = ?,
        updated_by_user_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)
    : db.prepare(`
      UPDATE contacts
      SET
        full_name = ?,
        first_name = ?,
        last_name = ?,
        normalized_name = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)

  const updateLinkedin = userId
    ? db.prepare(`
      UPDATE contacts
      SET
        linkedin_url = ?,
        updated_by_user_id = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)
    : db.prepare(`
      UPDATE contacts
      SET
        linkedin_url = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `)

  let updatedNames = 0
  let updatedLinkedinUrls = 0
  let linkedCompanies = 0
  let skipped = 0

  for (const contact of contacts) {
    const contactEmails = listContactEmailAddresses(db, contact.id, contact.email)
      .map((email) => normalizeEmail(email))
      .filter((email): email is string => Boolean(email))
    const uniqueEmails = [...new Set(contactEmails)]

    if (uniqueEmails.length === 0) {
      skipped += 1
      continue
    }

    const nameCandidates = new Set<string>()
    for (const email of uniqueEmails) {
      const meetingCandidates = nameCandidatesByEmail.get(email)
      if (meetingCandidates) {
        for (const candidate of meetingCandidates) {
          nameCandidates.add(candidate)
        }
      }
    }

    const emailPlaceholders = uniqueEmails.map(() => '?').join(', ')

    const participantNameRows = db
      .prepare(`
        SELECT DISTINCT display_name
        FROM email_message_participants
        WHERE display_name IS NOT NULL
          AND TRIM(display_name) <> ''
          AND (
            contact_id = ?
            OR lower(trim(email)) IN (${emailPlaceholders})
          )
        LIMIT 300
      `)
      .all(contact.id, ...uniqueEmails) as Array<{ display_name: string | null }>
    for (const row of participantNameRows) {
      const candidate = normalizePersonNameCandidate(row.display_name)
      if (candidate) nameCandidates.add(candidate)
    }

    const fromNameRows = db
      .prepare(`
        SELECT DISTINCT from_name
        FROM email_messages
        WHERE from_name IS NOT NULL
          AND TRIM(from_name) <> ''
          AND lower(trim(from_email)) IN (${emailPlaceholders})
        LIMIT 250
      `)
      .all(...uniqueEmails) as Array<{ from_name: string | null }>
    for (const row of fromNameRows) {
      const candidate = normalizePersonNameCandidate(row.from_name)
      if (candidate) nameCandidates.add(candidate)
    }

    let touched = false

    const bestName = pickBestNameCandidate(
      [...nameCandidates],
      contact.full_name,
      uniqueEmails[0] || contact.email || null
    )
    if (bestName && normalizeName(bestName) !== normalizeName(contact.full_name)) {
      const split = splitFullNameParts(bestName)
      if (userId) {
        updateName.run(
          bestName,
          split.firstName,
          split.lastName,
          normalizeName(bestName),
          userId,
          contact.id
        )
      } else {
        updateName.run(
          bestName,
          split.firstName,
          split.lastName,
          normalizeName(bestName),
          contact.id
        )
      }
      updatedNames += 1
      touched = true
    }

    if (!contact.primary_company_id) {
      let inferredCompanyId: string | null = inferCompanyIdFromEmails(uniqueEmails, userId, false)

      if (!inferredCompanyId) {
        const companyHits = new Map<string, number>()
        for (const email of uniqueEmails) {
          const emailCompanyHits = companyHitsByEmail.get(email)
          if (!emailCompanyHits) continue
          for (const [companyId, hitCount] of emailCompanyHits.entries()) {
            companyHits.set(companyId, (companyHits.get(companyId) || 0) + hitCount)
          }
        }

        let bestCompanyId: string | null = null
        let bestCompanyHits = 0
        for (const [companyId, hitCount] of companyHits.entries()) {
          if (hitCount > bestCompanyHits) {
            bestCompanyId = companyId
            bestCompanyHits = hitCount
          }
        }
        inferredCompanyId = bestCompanyId
      }

      if (!inferredCompanyId) {
        inferredCompanyId = inferCompanyIdFromEmails(uniqueEmails, userId, true)
      }

      if (inferredCompanyId && ensurePrimaryCompanyLink(db, contact.id, inferredCompanyId, userId)) {
        linkedCompanies += 1
        touched = true
      }
    }

    const linkedInSourceRows = db
      .prepare(`
        SELECT em.body_text, em.snippet
        FROM email_messages em
        WHERE
          lower(trim(em.from_email)) IN (${emailPlaceholders})
          OR EXISTS (
            SELECT 1
            FROM email_message_participants p
            WHERE p.message_id = em.id
              AND (
                p.contact_id = ?
                OR lower(trim(p.email)) IN (${emailPlaceholders})
              )
          )
        ORDER BY datetime(COALESCE(em.received_at, em.sent_at, em.created_at)) DESC
        LIMIT 200
      `)
      .all(...uniqueEmails, contact.id, ...uniqueEmails) as Array<{
      body_text: string | null
      snippet: string | null
    }>

    const linkedinCandidates = new Set<string>()
    for (const row of linkedInSourceRows) {
      for (const url of extractLinkedinUrlsFromText(row.body_text)) {
        linkedinCandidates.add(url)
      }
      for (const url of extractLinkedinUrlsFromText(row.snippet)) {
        linkedinCandidates.add(url)
      }
    }

    const bestLinkedinUrl = pickBestLinkedinUrl(contact.linkedin_url, [...linkedinCandidates])
    if (bestLinkedinUrl) {
      if (userId) {
        updateLinkedin.run(bestLinkedinUrl, userId, contact.id)
      } else {
        updateLinkedin.run(bestLinkedinUrl, contact.id)
      }
      updatedLinkedinUrls += 1
      touched = true
    }

    if (!touched) {
      skipped += 1
    }
  }

  return {
    scannedContacts: contacts.length,
    updatedNames,
    updatedLinkedinUrls,
    updatedTitles: 0,
    linkedCompanies,
    webLookups: 0,
    skipped
  }
}

export function enrichExistingContacts(
  userId: string | null = null,
  limit = 5000
): ContactEnrichmentResult {
  const db = getDatabase()
  const contacts = db
    .prepare(`
      SELECT
        c.id,
        c.full_name,
        c.first_name,
        c.last_name,
        c.email,
        c.primary_company_id,
        c.linkedin_url
      FROM contacts c
      WHERE
        (c.email IS NOT NULL AND TRIM(c.email) <> '')
        OR EXISTS (
          SELECT 1
          FROM contact_emails ce
          WHERE ce.contact_id = c.id
        )
      ORDER BY datetime(c.updated_at) DESC
      LIMIT ?
    `)
    .all(limit) as ContactEnrichmentCandidate[]

  return enrichContactCandidates(db, contacts, userId)
}

export function enrichContact(
  contactId: string,
  userId: string | null = null
): ContactEnrichmentResult {
  const normalizedContactId = contactId.trim()
  if (!normalizedContactId) {
    throw new Error('contactId is required')
  }

  const db = getDatabase()
  const contact = db
    .prepare(`
      SELECT
        c.id,
        c.full_name,
        c.first_name,
        c.last_name,
        c.email,
        c.primary_company_id,
        c.linkedin_url
      FROM contacts c
      WHERE c.id = ?
      LIMIT 1
    `)
    .get(normalizedContactId) as ContactEnrichmentCandidate | undefined

  if (!contact) {
    throw new Error('Contact not found')
  }

  return enrichContactCandidates(db, [contact], userId)
}

export function enrichContactsByIds(
  contactIds: string[],
  userId: string | null = null
): ContactEnrichmentResult {
  const normalizedIds = [...new Set(
    contactIds
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  )]

  if (normalizedIds.length === 0) {
    return {
      scannedContacts: 0,
      updatedNames: 0,
      updatedLinkedinUrls: 0,
      updatedTitles: 0,
      linkedCompanies: 0,
      webLookups: 0,
      skipped: 0
    }
  }

  const db = getDatabase()
  const contacts: ContactEnrichmentCandidate[] = []
  const chunkSize = 400

  for (let i = 0; i < normalizedIds.length; i += chunkSize) {
    const chunk = normalizedIds.slice(i, i + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(`
        SELECT
          c.id,
          c.full_name,
          c.first_name,
          c.last_name,
          c.email,
          c.primary_company_id,
          c.linkedin_url
        FROM contacts c
        WHERE c.id IN (${placeholders})
      `)
      .all(...chunk) as ContactEnrichmentCandidate[]
    contacts.push(...rows)
  }

  if (contacts.length === 0) {
    return {
      scannedContacts: 0,
      updatedNames: 0,
      updatedLinkedinUrls: 0,
      updatedTitles: 0,
      linkedCompanies: 0,
      webLookups: 0,
      skipped: 0
    }
  }

  return enrichContactCandidates(db, contacts, userId)
}

/** Given a list of emails, return a map of lowercase email -> contactId for any that match a known contact. */
export function resolveContactsByEmails(emails: string[]): Record<string, string> {
  if (!emails || emails.length === 0) return {}
  const db = getDatabase()
  const result: Record<string, string> = {}

  const placeholders = emails.map(() => '?').join(', ')
  const normalized = emails.map((e) => e.trim().toLowerCase())

  const rows = db
    .prepare(`
      SELECT ce.email, ce.contact_id
      FROM contact_emails ce
      WHERE lower(trim(ce.email)) IN (${placeholders})
      UNION
      SELECT lower(trim(c.email)), c.id
      FROM contacts c
      WHERE lower(trim(c.email)) IN (${placeholders})
        AND c.email IS NOT NULL
    `)
    .all(...normalized, ...normalized) as { email: string; contact_id: string }[]

  for (const row of rows) {
    result[row.email.toLowerCase().trim()] = row.contact_id
  }

  return result
}
