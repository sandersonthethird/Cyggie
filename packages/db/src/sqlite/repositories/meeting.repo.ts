import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../connection'
import { appendOutboxRow, currentSyncContext } from '../sync-wrapper'
import { deriveCalendarMeetingId } from '../../meeting-id'
import { normalizeDomain } from '@main/utils/email-parser'
import { planCompanyLinks } from '../../meeting-enrichment/plan'
import { loadCompanyExistingState, applyCompanyWritePlan } from './enrichment-store'
import type { MeetingRow } from '../schema'
import type { ChatMessage, Meeting, MeetingCompany, MeetingListFilter, MeetingStatus } from '@shared/types/meeting'
import type { MeetingPlatform } from '@shared/constants/meeting-apps'
import type { TranscriptSegment } from '@shared/types/recording'

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
    location: row.location ?? null,
    transcriptPath: row.transcript_path,
    summaryPath: row.summary_path,
    summary: row.summary ?? null,
    notes: row.notes,
    transcriptSegments: row.transcript_segments ? JSON.parse(row.transcript_segments) : null,
    transcriptDriveId: row.transcript_drive_id ?? null,
    summaryDriveId: row.summary_drive_id ?? null,
    templateId: row.template_id,
    speakerCount: row.speaker_count,
    speakerMap: JSON.parse(row.speaker_map || '{}'),
    speakerContactMap: {},
    attendees: row.attendees ? JSON.parse(row.attendees) : null,
    attendeeEmails: row.attendee_emails ? JSON.parse(row.attendee_emails) : null,
    selfName: row.self_name ?? null,
    transcriptProvider: (row.transcript_provider ?? null) as 'deepgram' | 'assemblyai' | null,
    meSpeakerIndex:
      typeof row.me_speaker_index === 'number'
        ? row.me_speaker_index
        : row.me_speaker_index == null
          ? null
          : Number(row.me_speaker_index),
    companies: row.companies ? JSON.parse(row.companies) : null,
    dismissedCompanies: row.dismissed_companies ? JSON.parse(row.dismissed_companies) : null,
    chatMessages: row.chat_messages ? JSON.parse(row.chat_messages) : null,
    recordingPath: row.recording_path ?? null,
    status: row.status as MeetingStatus,
    isGroupEvent: row.is_group_event === 1,
    isGroupEventUserSet: row.is_group_event_user_set === 1,
    isPrivate: row.is_private === 1 || row.is_private === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    company: row.company_id
      ? { id: row.company_id, name: row.company_name!, domain: row.company_domain ?? null, stage: (row.company_stage as MeetingCompany['stage']) ?? null, entityType: (row.company_entity_type as MeetingCompany['entityType']) ?? null }
      : null
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

export function createCompanyForMeeting(
  db: ReturnType<typeof getDatabase>,
  companyName: string,
  attendeeEmails: string[] | null | undefined,
  userId: string | null = null
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

  // This cascade runs inside the wrapped createMeeting/updateMeeting sync
  // transaction, so a context exists and we emit each owned-table row we touch
  // directly via appendOutboxRow (same pattern as setCompanyInvestors). Stamp
  // the row's lamport from the context so the lamport='0' "never synced"
  // sentinel stays accurate for the backfill. Without this, the company exists
  // only in local SQLite and never reaches Neon (invisible on mobile).
  const ctx = currentSyncContext()
  const lamport = ctx?.lamport ?? '0'

  const companyId = uuidv4()
  const insertResult = db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, primary_domain, status,
      created_by_user_id, updated_by_user_id, lamport, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(normalized_name) DO NOTHING
  `).run(companyId, trimmed, normalized, primaryDomain, userId, userId, lamport)

  const row = db
    .prepare('SELECT * FROM org_companies WHERE normalized_name = ? LIMIT 1')
    .get(normalized) as Record<string, unknown> | undefined
  if (!row?.['id']) return null
  const resolvedId = row['id'] as string

  // Emit the company only when THIS call actually inserted it (ON CONFLICT DO
  // NOTHING → changes === 0 when the row already existed).
  if (ctx && insertResult.changes > 0) {
    appendOutboxRow(db, { table: 'org_companies', op: 'insert', row })
  }

  const emitAlias = (aliasValue: string, aliasType: 'name' | 'domain'): void => {
    const aliasId = uuidv4()
    const aliasResult = db.prepare(`
      INSERT OR IGNORE INTO org_company_aliases (
        id, company_id, alias_value, alias_type, lamport, created_at
      )
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(aliasId, resolvedId, aliasValue, aliasType, lamport)
    if (ctx && aliasResult.changes > 0) {
      const aliasRow = db
        .prepare('SELECT * FROM org_company_aliases WHERE id = ?')
        .get(aliasId) as Record<string, unknown> | undefined
      if (aliasRow) {
        appendOutboxRow(db, { table: 'org_company_aliases', op: 'insert', row: aliasRow })
      }
    }
  }

  emitAlias(trimmed, 'name')
  if (primaryDomain) {
    for (const candidate of getDomainLookupCandidates(primaryDomain)) {
      emitAlias(candidate, 'domain')
    }
  }

  return resolvedId
}

function syncMeetingCompanyLinks(
  meetingId: string,
  companies: string[] | null | undefined,
  attendeeEmails: string[] | null | undefined,
  confidence = 0.7,
  linkedBy = 'auto',
  userId: string | null = null
): void {
  // Company match/derive/link/prune decisions now run in the shared planner
  // (planCompanyLinks), applied by the SqliteEnrichmentStore — same rows + outbox.
  const seedNames = [...new Set((companies || []).map((name) => name.trim()).filter(Boolean))]
  const existing = loadCompanyExistingState(meetingId, seedNames, attendeeEmails ?? [])

  // Desktop's company path is NOT gated on isGroupEvent (only the contact path is),
  // so pass isGroupEvent:false. Pass an explicit (possibly empty) companies array so
  // the planner uses it verbatim and never derives seed names from attendee domains
  // (the original syncMeetingCompanyLinks only ever used the meeting's companies col).
  const plan = planCompanyLinks(
    existing,
    { attendees: null, attendeeEmails: attendeeEmails ?? null },
    { meetingId, ownerEmail: null, isGroupEvent: false, companies: companies ?? [] },
  )

  // Parity guard: planCompanyLinks early-returns an EMPTY plan when there are no seed
  // names AND no attendees, but the original pruned ALL links in that case (companyIds
  // empty → delete every link for the meeting). Reproduce the prune-all so clearing a
  // meeting's companies still unlinks.
  if (seedNames.length === 0 && (attendeeEmails?.length ?? 0) === 0) {
    plan.companyLinksToPrune = existing.currentMeetingCompanyLinkIds.map((companyId) => ({
      meetingId,
      companyId,
    }))
  }

  applyCompanyWritePlan(plan, { userId, attendeeEmails, confidence, linkedBy })
}

export function createMeeting(data: {
  title: string
  date: string
  meetingPlatform?: MeetingPlatform | null
  meetingUrl?: string | null
  location?: string | null
  calendarEventId?: string | null
  attendees?: string[] | null
  attendeeEmails?: string[] | null
  selfName?: string | null
  companies?: string[] | null
  status?: MeetingStatus
  isGroupEvent?: boolean
}, userId: string | null = null): Meeting {
  const db = getDatabase()
  // Calendar-sourced meetings get a deterministic id derived from
  // (userId, calendarEventId) so desktop and the gateway converge on the SAME
  // row instead of diverging (see @cyggie/db/meeting-id). Impromptu / Record-FAB
  // rows (no calendar event) — or the rare case with no userId — keep a random
  // uuid. The findMeetingByCalendarEventId guard in prepareMeetingFromCalendarEvent
  // already prevents creating a second row for an event that pre-dates this.
  const id =
    data.calendarEventId && userId
      ? deriveCalendarMeetingId(userId, data.calendarEventId)
      : uuidv4()

  db.prepare(
    `INSERT INTO meetings (
      id, title, date, meeting_platform, meeting_url, location, calendar_event_id,
      attendees, attendee_emails, self_name, companies, status, is_group_event,
      created_by_user_id, updated_by_user_id
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.title,
    data.date,
    data.meetingPlatform ?? null,
    data.meetingUrl ?? null,
    data.location ?? null,
    data.calendarEventId ?? null,
    data.attendees ? JSON.stringify(data.attendees) : null,
    data.attendeeEmails ? JSON.stringify(data.attendeeEmails) : null,
    data.selfName ?? null,
    data.companies ? JSON.stringify(data.companies) : null,
    data.status ?? 'recording',
    data.isGroupEvent ? 1 : 0,
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

export function getMeetingSpeakerContactMap(meetingId: string): Record<number, string> {
  const db = getDatabase()
  const rows = db
    .prepare('SELECT speaker_index, contact_id FROM meeting_speaker_contact_links WHERE meeting_id = ?')
    .all(meetingId) as { speaker_index: number; contact_id: string }[]
  return Object.fromEntries(rows.map((r) => [r.speaker_index, r.contact_id]))
}

export function getMeeting(id: string): Meeting | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as MeetingRow | undefined
  if (!row) return null
  const meeting = rowToMeeting(row)
  meeting.speakerContactMap = getMeetingSpeakerContactMap(id)
  return meeting
}

// Lightweight read for callers that need meeting metadata but NOT the
// transcript. The explicit column list pulls every field except
// transcript_segments and chat_messages — each can be many MB per row — so
// rowToMeeting falls back to null for just those two (same trick as
// listMeetings). It also skips the speakerContactMap lookup, which lite
// callers never read. Use this instead of getMeeting on hot paths that don't
// render the transcript.
export function getMeetingLite(id: string): Meeting | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT
        m.id, m.title, m.date, m.duration_seconds,
        m.calendar_event_id, m.meeting_platform, m.meeting_url, m.location,
        m.transcript_path, m.summary_path, m.summary, m.notes,
        m.transcript_drive_id, m.summary_drive_id,
        m.template_id, m.speaker_count, m.speaker_map,
        m.attendees, m.attendee_emails, m.self_name,
        m.transcript_provider, m.me_speaker_index,
        m.companies, m.dismissed_companies,
        m.recording_path, m.status,
        m.is_group_event, m.is_group_event_user_set, m.is_private,
        m.created_at, m.updated_at
      FROM meetings m
      WHERE m.id = ?
    `)
    .get(id) as MeetingRow | undefined
  if (!row) return null
  return rowToMeeting(row)
}

export function listMeetings(filter?: MeetingListFilter): Meeting[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter?.dateFrom) {
    conditions.push('m.date >= ?')
    params.push(filter.dateFrom)
  }
  if (filter?.dateTo) {
    conditions.push('m.date <= ?')
    params.push(filter.dateTo)
  }
  if (filter?.platform) {
    conditions.push('m.meeting_platform = ?')
    params.push(filter.platform)
  }
  if (filter?.status) {
    conditions.push('m.status = ?')
    params.push(filter.status)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const hasLimit = Number.isFinite(filter?.limit) && Number(filter?.limit) >= 0
  const hasOffset = Number.isFinite(filter?.offset) && Number(filter?.offset) > 0
  const limit = hasLimit
    ? `LIMIT ${Math.floor(Number(filter!.limit))}`
    : (hasOffset ? 'LIMIT -1' : '')
  const offset = hasOffset ? `OFFSET ${Math.floor(Number(filter!.offset))}` : ''

  // Explicit column list: omits transcript_segments and chat_messages because
  // list views never need them and they can be many MB per row. The detail
  // view (MEETING_GET) still uses SELECT * and rowToMeeting falls back to
  // null when those fields aren't present on the row object.
  const rows = db
    .prepare(`
      SELECT
        m.id, m.title, m.date, m.duration_seconds,
        m.calendar_event_id, m.meeting_platform, m.meeting_url,
        m.transcript_path, m.summary_path, m.notes,
        m.transcript_drive_id, m.summary_drive_id,
        m.template_id, m.speaker_count, m.speaker_map,
        m.attendees, m.attendee_emails, m.self_name,
        m.companies, m.dismissed_companies,
        m.recording_path, m.status,
        m.created_at, m.updated_at,
        c.id AS company_id,
        c.canonical_name AS company_name,
        c.primary_domain AS company_domain,
        c.stage AS company_stage,
        c.entity_type AS company_entity_type
      FROM meetings m
      LEFT JOIN meeting_company_links mcl ON mcl.meeting_id = m.id
      LEFT JOIN org_companies c ON c.id = mcl.company_id
      ${where}
      GROUP BY m.id
      ORDER BY m.date DESC ${limit} ${offset}
    `)
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
    /**
     * AI-generated meeting summary markdown. Dual-written by the desktop
     * summarizer alongside summaryPath so mobile can render it via
     * GET /meetings/:id. See packages/services/src/llm/summarizer.ts.
     */
    summary: string | null
    notes: string | null
    transcriptSegments: TranscriptSegment[] | null
    transcriptDriveId: string
    summaryDriveId: string
    templateId: string
    speakerCount: number
    speakerMap: Record<number, string>
    attendees: string[] | null
    attendeeEmails: string[] | null
    selfName: string | null
    /**
     * Live transcription provider that produced this meeting's transcript
     * ('deepgram' or 'assemblyai'). Set by RecordingSession on finalize.
     * NULL for meetings recorded before the 2026-05-28 picker rollout.
     */
    transcriptProvider: 'deepgram' | 'assemblyai' | null
    /**
     * Deepgram speaker index that belongs to the recording user. Drives
     * the me/them bubble view: render-time wrapper aligns segments with
     * this index on the right ("me"), everything else on the left
     * ("them"). Set by RecordingSession on finalize via
     * `resolveMeSpeakerIndex`. Updated by the Swap Me/Them button.
     */
    meSpeakerIndex: number | null
    companies: string[] | null
    dismissedCompanies: string[] | null
    chatMessages: ChatMessage[] | null
    recordingPath: string | null
    status: MeetingStatus
    isGroupEvent: boolean
    isGroupEventUserSet: boolean
    /** Phase 4 — owner-only privacy opt-out (firm-shared when false). */
    isPrivate: boolean
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
  if (data.summary !== undefined) {
    sets.push('summary = ?')
    params.push(data.summary)
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
  if (data.selfName !== undefined) {
    sets.push('self_name = ?')
    params.push(data.selfName)
  }
  if (data.transcriptProvider !== undefined) {
    sets.push('transcript_provider = ?')
    params.push(data.transcriptProvider)
  }
  if (data.meSpeakerIndex !== undefined) {
    sets.push('me_speaker_index = ?')
    params.push(data.meSpeakerIndex)
  }
  if (data.companies !== undefined) {
    sets.push('companies = ?')
    params.push(data.companies ? JSON.stringify(data.companies) : null)
  }
  if (data.dismissedCompanies !== undefined) {
    sets.push('dismissed_companies = ?')
    params.push(data.dismissedCompanies ? JSON.stringify(data.dismissedCompanies) : null)
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
  if (data.isGroupEvent !== undefined) {
    sets.push('is_group_event = ?')
    params.push(data.isGroupEvent ? 1 : 0)
  }
  if (data.isGroupEventUserSet !== undefined) {
    sets.push('is_group_event_user_set = ?')
    params.push(data.isGroupEventUserSet ? 1 : 0)
  }
  if (data.isPrivate !== undefined) {
    sets.push('is_private = ?')
    params.push(data.isPrivate ? 1 : 0)
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
 * Delete *truly empty* scheduled meeting stubs whose date has passed (>2h ago).
 * A row qualifies for deletion only if the user never engaged with it:
 *   - no notes typed
 *   - no calendar event link (notifier seed / reconcile / MEETING_PREPARE all
 *     set calendar_event_id, so this protects user-engaged rows)
 *   - no attendees attached
 * Rows seeded automatically from calendar events survive. See "i had a meeting"
 * plan for context.
 */
export function cleanupExpiredScheduledMeetings(): number {
  const db = getDatabase()
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const condition = `
    status = 'scheduled'
    AND date < ?
    AND (notes IS NULL OR trim(notes) = '')
    AND calendar_event_id IS NULL
    AND (attendees IS NULL OR attendees = '[]')
  `

  // First get the IDs so we can clean up FTS too
  const expiredRows = db.prepare(
    `SELECT id FROM meetings WHERE ${condition}`
  ).all(twoHoursAgo) as { id: string }[]

  if (expiredRows.length === 0) return 0

  // Delete from FTS
  for (const row of expiredRows) {
    db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(row.id)
  }

  // Delete the meetings
  const result = db.prepare(
    `DELETE FROM meetings WHERE ${condition}`
  ).run(twoHoursAgo)

  return result.changes
}

// =============================================================================
// meeting_speaker_contact_links — speaker→contact tag on a transcribed meeting.
//
// Both functions are raw (un-wrapped); the barrel wraps them with withSync()
// so the link row reaches Neon. Before that wrapping landed, the IPC handler
// for MEETING_TAG_SPEAKER_CONTACT did `INSERT OR REPLACE` / `DELETE` directly
// in-line, which mutated SQLite without emitting an outbox row — mobile never
// saw the link, breaking the contact-detail "Meetings" tab + Last Touch stat
// for any tagged-but-not-attendee contact.
// =============================================================================

export function linkMeetingSpeakerContact(
  meetingId: string,
  speakerIndex: number,
  contactId: string,
): void {
  const db = getDatabase()
  db.prepare(
    'INSERT OR REPLACE INTO meeting_speaker_contact_links (meeting_id, speaker_index, contact_id) VALUES (?, ?, ?)',
  ).run(meetingId, speakerIndex, contactId)
}

export function unlinkMeetingSpeakerContact(
  meetingId: string,
  speakerIndex: number,
): void {
  const db = getDatabase()
  db.prepare(
    'DELETE FROM meeting_speaker_contact_links WHERE meeting_id = ? AND speaker_index = ?',
  ).run(meetingId, speakerIndex)
}

/**
 * deleteMeeting — cleanup waterfall.
 *
 *   (a) FK CASCADE auto: meeting_company_links, email_attachments,
 *       meeting_speaker_contact_links, partner_meeting_items (via meeting_id).
 *   (b) FK SET NULL auto: notes.source_meeting_id.
 *   (c) Explicit DELETE: meetings_fts (no FK; FTS table indexed on meeting_id).
 *   (d) No FK / manual cleanup:
 *       chat_sessions (context_kind='meeting' AND context_id=id) — mig 078.
 *
 * Wrapped in a transaction so meetings/FTS/chat_sessions stay atomic.
 */
export function deleteMeeting(id: string): boolean {
  const db = getDatabase()
  let changes = 0
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM chat_sessions WHERE context_kind = 'meeting' AND context_id = ?`).run(id)
    db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?').run(id)
    const result = db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
    changes = result.changes
  })
  tx()
  return changes > 0
}

// =============================================================================
// Group-event ingestion gate (migration 098)
//
// Three pieces split for clarity:
//   • shouldSyncAttendees(meetingId)        — read-only gate (called from sync sites)
//   • computeAutoGroupEventFlag(...)        — pure, decides whether to write
//   • Writes go through updateMeeting({isGroupEvent, isGroupEventUserSet})
//     so the sync agent picks them up via the existing withSync wrap.
// =============================================================================

/**
 * Returns false when the meeting is flagged as a group event — caller should
 * skip syncContactsFromAttendees + meeting_company_links auto-population.
 * Returns false defensively when the meeting row can't be found (logged but
 * non-fatal; the caller's sync would no-op against missing data anyway).
 */
export function shouldSyncAttendees(meetingId: string): boolean {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT is_group_event FROM meetings WHERE id = ?`)
    .get(meetingId) as { is_group_event: number } | undefined
  if (!row) {
    console.warn(`[meeting:sync-gated] meetingId=${meetingId} reason=missing-row`)
    return false
  }
  if (row.is_group_event === 1) {
    console.debug(`[meeting:sync-gated] meetingId=${meetingId} reason=is_group_event`)
    return false
  }
  return true
}

/**
 * Pure auto-flag computation. Returns the value to write, or null if the row
 * should not be touched.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  user_set=true  →  null (no-write, locked by user toggle)  │
 *   │  user_set=false →  newFlag = (count > THRESHOLD)           │
 *   │                    null if unchanged, else newFlag         │
 *   └────────────────────────────────────────────────────────────┘
 */
export function computeAutoGroupEventFlag(
  attendeeCount: number,
  userSet: boolean,
  currentFlag: boolean,
  threshold: number,
): boolean | null {
  if (userSet) return null
  const newFlag = attendeeCount > threshold
  return newFlag === currentFlag ? null : newFlag
}
