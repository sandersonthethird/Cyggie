import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type { ContactSummary, ContactSyncResult } from '../../../shared/types/contact'

interface ContactRow {
  id: string
  full_name: string
  normalized_name: string
  email: string | null
  primary_company_id: string | null
  title: string | null
  linkedin_url: string | null
  crm_contact_id: string | null
  crm_provider: string | null
  created_at: string
  updated_at: string
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
  attendees: string | null
  attendee_emails: string | null
}

function rowToContactSummary(row: ContactRow): ContactSummary {
  return {
    id: row.id,
    fullName: row.full_name,
    normalizedName: row.normalized_name,
    email: row.email,
    primaryCompanyId: row.primary_company_id,
    title: row.title,
    linkedinUrl: row.linkedin_url,
    crmContactId: row.crm_contact_id,
    crmProvider: row.crm_provider,
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

function applyCandidates(candidates: CandidateContact[]): ContactSyncStats {
  const db = getDatabase()
  const getByEmail = db.prepare('SELECT id, full_name, normalized_name FROM contacts WHERE email = ?')
  const insertContact = db.prepare(`
    INSERT INTO contacts (
      id, full_name, normalized_name, email, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `)
  const updateContact = db.prepare(`
    UPDATE contacts
    SET full_name = ?, normalized_name = ?, updated_at = datetime('now')
    WHERE id = ?
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
      const existing = getByEmail.get(candidate.email) as {
        id: string
        full_name: string
        normalized_name: string
      } | undefined

      if (!existing) {
        insertContact.run(randomUUID(), candidate.fullName, candidate.normalizedName, candidate.email)
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

      if (nextName !== existing.full_name || nextNormalized !== existing.normalized_name) {
        updateContact.run(nextName, nextNormalized, existing.id)
        stats.updated += 1
      } else {
        stats.skipped += 1
      }
    }
  })

  upsertTransaction(candidates)
  return stats
}

export function listContacts(filter?: {
  query?: string
  limit?: number
  offset?: number
}): ContactSummary[] {
  const db = getDatabase()
  const query = filter?.query?.trim()
  const params: unknown[] = []
  const conditions: string[] = ['email IS NOT NULL']

  if (query) {
    conditions.push('(full_name LIKE ? OR email LIKE ?)')
    const like = `%${query}%`
    params.push(like, like)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filter?.limit ?? 200
  const offset = filter?.offset ?? 0

  const rows = db
    .prepare(`
      SELECT
        id,
        full_name,
        normalized_name,
        email,
        primary_company_id,
        title,
        linkedin_url,
        crm_contact_id,
        crm_provider,
        created_at,
        updated_at
      FROM contacts
      ${where}
      ORDER BY full_name ASC, email ASC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as ContactRow[]

  return rows.map(rowToContactSummary)
}

export function createContact(data: {
  fullName: string
  email: string
  title?: string | null
}): ContactSummary {
  const db = getDatabase()
  const fullName = data.fullName.trim()
  if (!fullName) {
    throw new Error('Contact name is required')
  }

  const email = normalizeEmail(data.email)
  if (!email) {
    throw new Error('Valid contact email is required')
  }

  const normalizedName = normalizeName(fullName)
  const id = randomUUID()

  db.prepare(`
    INSERT INTO contacts (
      id, full_name, normalized_name, email, title, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(email) DO UPDATE SET
      full_name = excluded.full_name,
      normalized_name = excluded.normalized_name,
      title = COALESCE(excluded.title, contacts.title),
      updated_at = datetime('now')
  `).run(
    id,
    fullName,
    normalizedName,
    email,
    data.title?.trim() || null
  )

  const row = db
    .prepare(`
      SELECT
        id,
        full_name,
        normalized_name,
        email,
        primary_company_id,
        title,
        linkedin_url,
        crm_contact_id,
        crm_provider,
        created_at,
        updated_at
      FROM contacts
      WHERE email = ?
      LIMIT 1
    `)
    .get(email) as ContactRow | undefined

  if (!row) {
    throw new Error('Failed to create or load contact')
  }

  return rowToContactSummary(row)
}

export function syncContactsFromAttendees(
  attendees: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined
): ContactSyncStats {
  const { candidates, invalid } = buildCandidateMap(attendees, attendeeEmails)
  const result = applyCandidates(candidates)
  return {
    ...result,
    invalid
  }
}

export function syncContactsFromMeetings(): ContactSyncResult {
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

  const result = applyCandidates([...mergedMap.values()])
  return {
    scannedMeetings: rows.length,
    candidates: result.candidates,
    inserted: result.inserted,
    updated: result.updated,
    skipped: result.skipped,
    invalid
  }
}
