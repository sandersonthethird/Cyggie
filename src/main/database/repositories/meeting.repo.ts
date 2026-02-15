import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../connection'
import type { MeetingRow } from '../schema'
import type { ChatMessage, Meeting, MeetingListFilter, MeetingStatus } from '../../../shared/types/meeting'
import type { MeetingPlatform } from '../../../shared/constants/meeting-apps'
import type { TranscriptSegment } from '../../../shared/types/recording'

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
    status: row.status as MeetingStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
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
}): Meeting {
  const db = getDatabase()
  const id = uuidv4()

  db.prepare(
    `INSERT INTO meetings (id, title, date, meeting_platform, meeting_url, calendar_event_id, attendees, attendee_emails, companies, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    data.status ?? 'recording'
  )

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
  const limit = filter?.limit ? `LIMIT ${filter.limit}` : 'LIMIT 100'
  const offset = filter?.offset ? `OFFSET ${filter.offset}` : ''

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
    status: MeetingStatus
  }>
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
  if (data.status !== undefined) {
    sets.push('status = ?')
    params.push(data.status)
  }

  if (sets.length === 0) return getMeeting(id)

  sets.push("updated_at = datetime('now')")
  params.push(id)

  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getMeeting(id)
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
