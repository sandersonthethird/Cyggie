import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type {
  ContactSummary,
  ContactSyncResult,
  ContactDetail,
  ContactMeetingRef,
  ContactEmailRef
} from '../../../shared/types/contact'

interface ContactRow {
  id: string
  full_name: string
  first_name: string | null
  last_name: string | null
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
  id?: string
  title?: string
  date?: string
  status?: string
  duration_seconds?: number | null
  attendees: string | null
  attendee_emails: string | null
}

function rowToContactSummary(row: ContactRow): ContactSummary {
  return {
    id: row.id,
    fullName: row.full_name,
    firstName: row.first_name,
    lastName: row.last_name,
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

function splitFullNameParts(fullName: string): { firstName: string | null; lastName: string | null } {
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

function applyCandidates(candidates: CandidateContact[]): ContactSyncStats {
  const db = getDatabase()
  const getByEmail = db.prepare(`
    SELECT c.id, c.full_name, c.first_name, c.last_name, c.normalized_name, c.email
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
      id, full_name, first_name, last_name, normalized_name, email, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `)
  const updateContact = db.prepare(`
    UPDATE contacts
    SET
      full_name = ?,
      first_name = ?,
      last_name = ?,
      normalized_name = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `)
  const updateContactPrimaryEmail = db.prepare(`
    UPDATE contacts
    SET email = ?, updated_at = datetime('now')
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
      } | undefined

      if (!existing) {
        const contactId = randomUUID()
        const split = splitFullNameParts(candidate.fullName)
        insertContact.run(
          contactId,
          candidate.fullName,
          split.firstName,
          split.lastName,
          candidate.normalizedName,
          candidate.email
        )
        attachEmailToContact(db, contactId, candidate.email, true)
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
        updateContact.run(nextName, split.firstName, split.lastName, nextNormalized, existing.id)
        stats.updated += 1
      } else {
        stats.skipped += 1
      }

      if (!existing.email || !existing.email.trim()) {
        updateContactPrimaryEmail.run(candidate.email, existing.id)
      }
      attachEmailToContact(
        db,
        existing.id,
        candidate.email,
        !existing.email || normalizeEmail(existing.email || '') === candidate.email
      )
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
        first_name,
        last_name,
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
  firstName?: string | null
  lastName?: string | null
  email: string
  title?: string | null
}): ContactSummary {
  const db = getDatabase()
  const providedFirstName = (data.firstName || '').trim()
  const providedLastName = (data.lastName || '').trim()
  const explicitName = [providedFirstName, providedLastName].filter(Boolean).join(' ').trim()
  const fullName = (explicitName || data.fullName || '').trim()
  if (!fullName) {
    throw new Error('Contact name is required')
  }

  const email = normalizeEmail(data.email)
  if (!email) {
    throw new Error('Valid contact email is required')
  }

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
      linkedin_url,
      crm_contact_id,
      crm_provider,
      created_at,
      updated_at
    FROM contacts
    WHERE id = ?
    LIMIT 1
  `)

  const existing = db
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

  let contactId = existing?.id || null

  if (!contactId) {
    contactId = randomUUID()
    db.prepare(`
      INSERT INTO contacts (
        id, full_name, first_name, last_name, normalized_name, email, title, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      contactId,
      fullName,
      splitName.firstName,
      splitName.lastName,
      normalizedName,
      email,
      data.title?.trim() || null
    )
    attachEmailToContact(db, contactId, email, true)
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

    const primaryEmail = normalizeEmail(existing?.email || '')
    attachEmailToContact(db, contactId, email, !primaryEmail || primaryEmail === email)
  }

  const row = selectById.get(contactId) as ContactRow | undefined

  if (!row) {
    throw new Error('Failed to create or load contact')
  }

  return rowToContactSummary(row)
}

export function addContactEmail(contactId: string, emailInput: string): ContactDetail {
  const db = getDatabase()
  const email = normalizeEmail(emailInput)
  if (!email) {
    throw new Error('Valid contact email is required')
  }

  const contact = db
    .prepare(`
      SELECT id, email
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `)
    .get(contactId) as { id: string; email: string | null } | undefined
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
      db.prepare(`
        UPDATE contacts
        SET email = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(email, contactId)
    }
    attachEmailToContact(db, contactId, email, shouldBePrimary)
  })
  tx()

  const updated = getContact(contactId)
  if (!updated) {
    throw new Error('Failed to load updated contact')
  }
  return updated
}

export function setContactPrimaryCompany(contactId: string, companyId: string | null): ContactDetail {
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

  const updatePrimaryCompany = db.prepare(`
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
    updatePrimaryCompany.run(nextCompanyId, contactId)
    if (!nextCompanyId) {
      deleteAllLinksForContact.run(contactId)
      return
    }

    deleteOtherLinksForContact.run(contactId, nextCompanyId)
    upsertCompanyContactLink.run(nextCompanyId, contactId)
  })

  tx(companyId)

  const updated = getContact(contactId)
  if (!updated) {
    throw new Error('Failed to load updated contact')
  }
  return updated
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
  }

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
