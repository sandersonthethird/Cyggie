import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../connection'
import type { MeetingRow } from '../schema'
import type { ChatMessage, Meeting, MeetingListFilter, MeetingStatus } from '../../../shared/types/meeting'
import type { MeetingPlatform } from '../../../shared/constants/meeting-apps'
import type { TranscriptSegment } from '../../../shared/types/recording'

const COMMON_SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu'])

function rowToMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    durationSeconds: row.duration_seconds,
    calendarEventId: row.calendar_event_id,
    meetingPlatform: row.meeting_platform as MeetingPlatform | null,
    meetingUrl: row.meeting_url,
    transcriptPath: row.transcript_path,
    summaryPath: row.summary_path,
    notes: row.notes,
    transcriptSegments: row.transcript_segments ? JSON.parse(row.transcript_segments) : null,
    transcriptDriveId: row.transcript_drive_id ?? null,
    summaryDriveId: row.summary_drive_id ?? null,
    templateId: row.template_id,
    speakerCount: row.speaker_count,
    speakerMap: JSON.parse(row.speaker_map || '{}'),
    attendees: row.attendees ? JSON.parse(row.attendees) : null,
    attendeeEmails: row.attendee_emails ? JSON.parse(row.attendee_emails) : null,
    companies: row.companies ? JSON.parse(row.companies) : null,
    chatMessages: row.chat_messages ? JSON.parse(row.chat_messages) : null,
    recordingPath: row.recording_path ?? null,
    status: row.status as MeetingStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
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

function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!cleaned) return null
  return cleaned.replace(/^www\./, '')
}

function getRegistrableDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')

  const tld = labels[labels.length - 1]
  const secondLevel = labels[labels.length - 2]
  if (tld.length === 2 && COMMON_SECOND_LEVEL_TLDS.has(secondLevel) && labels.length >= 3) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

function getDomainLookupCandidates(domain: string): string[] {
  const normalized = normalizeDomain(domain)
  if (!normalized) return []
  const registrable = getRegistrableDomain(normalized)
  return [...new Set([normalized, registrable, `www.${registrable}`])]
}

function extractEmailDomain(email: string): string | null {
  const normalized = email.trim().toLowerCase()
  const match = normalized.match(/^[^@\s]+@([^@\s]+)$/)
  if (!match?.[1]) return null
  return normalizeDomain(match[1])
}

function findExistingCompanyId(
  db: ReturnType<typeof getDatabase>,
  companyName: string,
  attendeeEmails: string[] | null | undefined
): string | null {
  const normalizedName = normalizeCompanyName(companyName)
  if (!normalizedName) return null

  const byName = db
    .prepare('SELECT id FROM org_companies WHERE normalized_name = ? LIMIT 1')
    .get(normalizedName) as { id: string } | undefined
  if (byName?.id) return byName.id

  const byNameAlias = db
    .prepare(`
      SELECT company_id
      FROM org_company_aliases
      WHERE alias_type = 'name'
        AND lower(trim(alias_value)) = lower(trim(?))
      LIMIT 1
    `)
    .get(companyName.trim()) as { company_id: string } | undefined
  if (byNameAlias?.company_id) return byNameAlias.company_id

  const emailDomains = new Set<string>()
  for (const email of attendeeEmails || []) {
    const domain = extractEmailDomain(email)
    if (!domain) continue
    emailDomains.add(domain)
    emailDomains.add(getRegistrableDomain(domain))
  }

  if (emailDomains.size === 0) return null

  const findByPrimaryDomain = db.prepare(`
    SELECT id
    FROM org_companies
    WHERE lower(trim(primary_domain)) = ?
       OR (
         CASE
           WHEN lower(trim(primary_domain)) LIKE 'www.%' THEN substr(lower(trim(primary_domain)), 5)
           ELSE lower(trim(primary_domain))
         END
       ) = ?
    LIMIT 1
  `)
  const findByDomainAlias = db.prepare(`
    SELECT company_id
    FROM org_company_aliases
    WHERE alias_type = 'domain'
      AND lower(trim(alias_value)) = lower(trim(?))
    LIMIT 1
  `)

  for (const domain of emailDomains) {
    for (const candidate of getDomainLookupCandidates(domain)) {
      const byDomain = findByPrimaryDomain.get(candidate, candidate) as { id: string } | undefined
      if (byDomain?.id) return byDomain.id
      const byDomainAlias = findByDomainAlias.get(candidate) as { company_id: string } | undefined
      if (byDomainAlias?.company_id) return byDomainAlias.company_id
    }
  }

  return null
}

function createCompanyForMeeting(
  db: ReturnType<typeof getDatabase>,
  companyName: string,
  attendeeEmails: string[] | null | undefined
): string | null {
  const trimmed = companyName.trim()
  const normalized = normalizeCompanyName(trimmed)
  if (!normalized) return null

  let primaryDomain: string | null = null
  const emailDomains = (attendeeEmails || [])
    .map((email) => extractEmailDomain(email))
    .filter((domain): domain is string => Boolean(domain))
  if (emailDomains.length > 0) {
    primaryDomain = getRegistrableDomain(emailDomains[0])
  }

  const companyId = uuidv4()
  db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, primary_domain, status, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    ON CONFLICT(normalized_name) DO NOTHING
  `).run(companyId, trimmed, normalized, primaryDomain)

  const row = db
    .prepare('SELECT id FROM org_companies WHERE normalized_name = ? LIMIT 1')
    .get(normalized) as { id: string } | undefined
  if (!row?.id) return null

  db.prepare(`
    INSERT OR IGNORE INTO org_company_aliases (
      id, company_id, alias_value, alias_type, created_at
    )
    VALUES (?, ?, ?, 'name', datetime('now'))
  `).run(uuidv4(), row.id, trimmed)

  if (primaryDomain) {
    for (const candidate of getDomainLookupCandidates(primaryDomain)) {
      db.prepare(`
        INSERT OR IGNORE INTO org_company_aliases (
          id, company_id, alias_value, alias_type, created_at
        )
        VALUES (?, ?, ?, 'domain', datetime('now'))
      `).run(uuidv4(), row.id, candidate)
    }
  }

  return row.id
}

function syncMeetingCompanyLinks(
  meetingId: string,
  companies: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined,
  confidence = 0.7,
  linkedBy = 'auto',
  userId: string | null = null
): void {
  const db = getDatabase()
  const names = [...new Set((companies || []).map((name) => name.trim()).filter(Boolean))]
  const companyIds = new Set<string>()

  for (const companyName of names) {
    const existingId = findExistingCompanyId(db, companyName, attendeeEmails)
    const companyId = existingId || createCompanyForMeeting(db, companyName, attendeeEmails)
    if (!companyId) continue
    companyIds.add(companyId)

    db.prepare(`
      INSERT INTO meeting_company_links (
        meeting_id, company_id, confidence, linked_by, created_by_user_id, updated_by_user_id, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(meeting_id, company_id) DO UPDATE SET
        confidence = CASE
          WHEN excluded.confidence > meeting_company_links.confidence THEN excluded.confidence
          ELSE meeting_company_links.confidence
        END,
        linked_by = excluded.linked_by,
        updated_by_user_id = excluded.updated_by_user_id
    `).run(meetingId, companyId, confidence, linkedBy, userId, userId)
  }

  if (companyIds.size === 0) {
    db.prepare('DELETE FROM meeting_company_links WHERE meeting_id = ?').run(meetingId)
    return
  }

  const placeholders = [...companyIds].map(() => '?').join(', ')
  db.prepare(`
    DELETE FROM meeting_company_links
    WHERE meeting_id = ?
      AND company_id NOT IN (${placeholders})
  `).run(meetingId, ...companyIds)
}

export function createMeeting(data: {
  title: string
  date: string
  meetingPlatform?: MeetingPlatform | null
  meetingUrl?: string | null
  calendarEventId?: string | null
  attendees?: string[] | null
  attendeeEmails?: string[] | null
  companies?: string[] | null
  status?: MeetingStatus
}, userId: string | null = null): Meeting {
  const db = getDatabase()
  const id = uuidv4()

  db.prepare(
    `INSERT INTO meetings (
      id, title, date, meeting_platform, meeting_url, calendar_event_id,
      attendees, attendee_emails, companies, status, created_by_user_id, updated_by_user_id
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.title,
    data.date,
    data.meetingPlatform ?? null,
    data.meetingUrl ?? null,
    data.calendarEventId ?? null,
    data.attendees ? JSON.stringify(data.attendees) : null,
    data.attendeeEmails ? JSON.stringify(data.attendeeEmails) : null,
    data.companies ? JSON.stringify(data.companies) : null,
    data.status ?? 'recording',
    userId,
    userId
  )

  const created = getMeeting(id)
  if (created && created.companies && created.companies.length > 0) {
    syncMeetingCompanyLinks(
      created.id,
      created.companies,
      created.attendeeEmails,
      0.7,
      'auto',
      userId
    )
  }

  return getMeeting(id)!
}

export function findMeetingByCalendarEventId(calendarEventId: string): Meeting | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM meetings WHERE calendar_event_id = ?').get(calendarEventId) as MeetingRow | undefined
  return row ? rowToMeeting(row) : null
}

export function getMeeting(id: string): Meeting | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined
  return row ? rowToMeeting(row) : null
}

export function listMeetings(filter?: MeetingListFilter): Meeting[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter?.dateFrom) {
    conditions.push('date >= ?')
    params.push(filter.dateFrom)
  }
  if (filter?.dateTo) {
    conditions.push('date <= ?')
    params.push(filter.dateTo)
  }
  if (filter?.platform) {
    conditions.push('meeting_platform = ?')
    params.push(filter.platform)
  }
  if (filter?.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const hasLimit = Number.isFinite(filter?.limit) && Number(filter?.limit) >= 0
  const hasOffset = Number.isFinite(filter?.offset) && Number(filter?.offset) > 0
  const limit = hasLimit
    ? `LIMIT ${Math.floor(Number(filter!.limit))}`
    : (hasOffset ? 'LIMIT -1' : '')
  const offset = hasOffset ? `OFFSET ${Math.floor(Number(filter!.offset))}` : ''

  const rows = db
    .prepare(`SELECT * FROM meetings ${where} ORDER BY date DESC ${limit} ${offset}`)
    .all(...params) as MeetingRow[]

  return rows.map(rowToMeeting)
}

export function updateMeeting(
  id: string,
  data: Partial<{
    title: string
    durationSeconds: number
    transcriptPath: string
    summaryPath: string
    notes: string | null
    transcriptSegments: TranscriptSegment[] | null
    transcriptDriveId: string
    summaryDriveId: string
    templateId: string
    speakerCount: number
    speakerMap: Record<number, string>
    attendees: string[] | null
    attendeeEmails: string[] | null
    companies: string[] | null
    chatMessages: ChatMessage[] | null
    recordingPath: string | null
    status: MeetingStatus
  }>
,
  userId: string | null = null
): Meeting | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.title !== undefined) {
    sets.push('title = ?')
    params.push(data.title)
  }
  if (data.durationSeconds !== undefined) {
    sets.push('duration_seconds = ?')
    params.push(data.durationSeconds)
  }
  if (data.transcriptPath !== undefined) {
    sets.push('transcript_path = ?')
    params.push(data.transcriptPath)
  }
  if (data.summaryPath !== undefined) {
    sets.push('summary_path = ?')
    params.push(data.summaryPath)
  }
  if (data.notes !== undefined) {
    sets.push('notes = ?')
    params.push(data.notes)
  }
  if (data.transcriptSegments !== undefined) {
    sets.push('transcript_segments = ?')
    params.push(data.transcriptSegments ? JSON.stringify(data.transcriptSegments) : null)
  }
  if (data.transcriptDriveId !== undefined) {
    sets.push('transcript_drive_id = ?')
    params.push(data.transcriptDriveId)
  }
  if (data.summaryDriveId !== undefined) {
    sets.push('summary_drive_id = ?')
    params.push(data.summaryDriveId)
  }
  if (data.templateId !== undefined) {
    sets.push('template_id = ?')
    params.push(data.templateId)
  }
  if (data.speakerCount !== undefined) {
    sets.push('speaker_count = ?')
    params.push(data.speakerCount)
  }
  if (data.speakerMap !== undefined) {
    sets.push('speaker_map = ?')
    params.push(JSON.stringify(data.speakerMap))
  }
  if (data.attendees !== undefined) {
    sets.push('attendees = ?')
    params.push(data.attendees ? JSON.stringify(data.attendees) : null)
  }
  if (data.attendeeEmails !== undefined) {
    sets.push('attendee_emails = ?')
    params.push(data.attendeeEmails ? JSON.stringify(data.attendeeEmails) : null)
  }
  if (data.companies !== undefined) {
    sets.push('companies = ?')
    params.push(data.companies ? JSON.stringify(data.companies) : null)
  }
  if (data.chatMessages !== undefined) {
    sets.push('chat_messages = ?')
    params.push(data.chatMessages ? JSON.stringify(data.chatMessages) : null)
  }
  if (data.recordingPath !== undefined) {
    sets.push('recording_path = ?')
    params.push(data.recordingPath)
  }
  if (data.status !== undefined) {
    sets.push('status = ?')
    params.push(data.status)
  }

  if (sets.length === 0) return getMeeting(id)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(id)

  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  const updated = getMeeting(id)
  if (updated && data.companies !== undefined) {
    syncMeetingCompanyLinks(
      updated.id,
      updated.companies,
      updated.attendeeEmails,
      0.7,
      'auto',
      userId
    )
  }

  return updated
}

export function cleanupStaleRecordings(): number {
  const db = getDatabase()
  const result = db.prepare("UPDATE meetings SET status = 'error' WHERE status = 'recording'").run()
  return result.changes
}

/**
 * Delete scheduled meetings whose date has passed (more than 2 hours ago).
 * These are meetings that were prepared but never recorded.
 */
export function cleanupExpiredScheduledMeetings(): number {
  const db = getDatabase()
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  // First get the IDs so we can clean up FTS too
  const expiredRows = db.prepare(
    "SELECT id FROM meetings WHERE status = 'scheduled' AND date < ?"
  ).all(twoHoursAgo) as { id: string }[]

  if (expiredRows.length === 0) return 0

  // Delete from FTS
  for (const row of expiredRows) {
    db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(row.id)
  }

  // Delete the meetings
  const result = db.prepare(
    "DELETE FROM meetings WHERE status = 'scheduled' AND date < ?"
  ).run(twoHoursAgo)

  return result.changes
}

export function deleteMeeting(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
  // Also remove from FTS
  db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(id)
  return result.changes > 0
}
