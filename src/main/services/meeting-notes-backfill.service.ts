/**
 * Backfills meeting summaries as contact_notes / company_notes for all historical
 * meetings. Safe to run multiple times — INSERT OR IGNORE + unique (entity, source_meeting_id)
 * constraint prevents duplicates.
 */
import { getDatabase } from '@cyggie/db/sqlite/connection'
import { readSummary } from '../storage/file-manager'
import { resolveContactsByEmails } from '@cyggie/db/sqlite/repositories'
import { listMeetingCompanies } from '@cyggie/db/sqlite/repositories'
import { createMeetingCompanionNote } from './note-companion-backfill.service'

interface MeetingRow {
  id: string
  title: string
  summary_path: string
  attendee_emails: string | null
}

export function backfillMeetingSummaryNotes(userId: string | null): { meetings: number; created: number; skipped: number } {
  const db = getDatabase()

  const meetings = db
    .prepare(`
      SELECT id, title, summary_path, attendee_emails
      FROM meetings
      WHERE summary_path IS NOT NULL
      ORDER BY date ASC
    `)
    .all() as MeetingRow[]

  let created = 0
  let skipped = 0

  for (const meeting of meetings) {
    let summary: string | null = null
    try {
      summary = readSummary(meeting.summary_path)
    } catch {
      skipped++
      continue
    }
    if (!summary) { skipped++; continue }

    const noteTitle = meeting.title?.trim() || 'Meeting'
    const noteContent = `${noteTitle}\n${summary}`

    // Company notes
    try {
      const companies = listMeetingCompanies(meeting.id)
      for (const company of companies) {
        const note = createMeetingCompanionNote({
          entityType: 'company',
          entityId: company.id,
          title: noteTitle,
          content: noteContent,
          sourceMeetingId: meeting.id
        }, userId)
        if (note) created++; else skipped++
      }
    } catch (err) {
      console.error(`[Backfill] Company notes failed for meeting ${meeting.id}:`, err)
    }

    // Contact notes
    try {
      const emails: string[] = JSON.parse(meeting.attendee_emails || '[]')
      if (emails.length > 0) {
        const emailToContactId = resolveContactsByEmails(emails)
        const contactIds = [...new Set(Object.values(emailToContactId).map((c) => c.id))]
        for (const contactId of contactIds) {
          const note = createMeetingCompanionNote({
            entityType: 'contact',
            entityId: contactId,
            title: noteTitle,
            content: noteContent,
            sourceMeetingId: meeting.id
          }, userId)
          if (note) created++; else skipped++
        }
      }
    } catch (err) {
      console.error(`[Backfill] Contact notes failed for meeting ${meeting.id}:`, err)
    }
  }

  console.log(`[Backfill] Meeting notes: ${created} created, ${skipped} skipped (${meetings.length} meetings)`)
  return { meetings: meetings.length, created, skipped }
}
