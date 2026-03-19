import { randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { getSummariesDir, getTranscriptsDir } from '../../storage/paths'

interface ManualMeetingRow {
  id: string
  title: string | null
  notes: string | null
  created_at: string
  updated_at: string
  created_by_user_id: string | null
}

interface AdHocMeetingRow extends ManualMeetingRow {
  summary_path: string | null
  transcript_path: string | null
}

const MAX_CONTENT_BYTES = 50_000

function readMeetingContent(summaryPath: string | null, transcriptPath: string | null): string {
  for (const [filename, dir] of [
    [summaryPath, getSummariesDir()],
    [transcriptPath, getTranscriptsDir()],
  ] as [string | null, string][]) {
    if (!filename) continue
    const fullPath = join(dir, filename)
    if (existsSync(fullPath)) {
      try {
        return readFileSync(fullPath, 'utf8').slice(0, MAX_CONTENT_BYTES)
      } catch { /* ignore read errors — fall through to next candidate */ }
    }
  }
  return ''
}

export function runConvertManualNotesMigration(db: Database.Database): void {
  db.transaction(() => {
    // Phase 1: Stub notes (+ New → Note) — scheduled meetings with no recording.
    // These are fully migrated: meeting row is deleted, replaced by a note row.
    const manualMeetings = db
      .prepare(
        `SELECT id, title, notes, created_at, updated_at, created_by_user_id
         FROM meetings
         WHERE status = 'scheduled'
           AND calendar_event_id IS NULL
           AND transcript_path IS NULL
           AND recording_path IS NULL`
      )
      .all() as ManualMeetingRow[]

    const getCompanyLink = db.prepare(
      `SELECT company_id FROM meeting_company_links WHERE meeting_id = ? LIMIT 1`
    )
    const insertNote = db.prepare(
      `INSERT INTO notes (id, title, content, company_id, source_meeting_id, is_pinned,
         created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    const deleteFts = db.prepare(`DELETE FROM meetings_fts WHERE meeting_id = ?`)
    const deleteMeeting = db.prepare(`DELETE FROM meetings WHERE id = ?`)

    for (const meeting of manualMeetings) {
      const companyLink = getCompanyLink.get(meeting.id) as { company_id: string } | undefined
      const newId = randomUUID()

      insertNote.run(
        newId,
        meeting.title ?? null,
        meeting.notes ?? '',
        companyLink?.company_id ?? null,
        null, // no source_meeting_id — this IS the note, not a companion to a meeting
        meeting.created_by_user_id ?? null,
        meeting.created_by_user_id ?? null,
        meeting.created_at,
        meeting.updated_at
      )

      deleteFts.run(meeting.id)
      deleteMeeting.run(meeting.id)
    }

    console.log(`[migration-053] Converted ${manualMeetings.length} stub note meeting(s) to notes`)

    // Phase 2: Ad-hoc recorded meetings — summarized/transcribed with no calendar event.
    // These stay in the meetings table but also get a companion note so they appear in
    // the Notes view and can be tagged to a contact. Reads summary/transcript content
    // from disk if available. Idempotent: skips meetings that already have a companion note.
    const adHocMeetings = db
      .prepare(
        `SELECT id, title, notes, summary_path, transcript_path, created_at, updated_at, created_by_user_id
         FROM meetings
         WHERE calendar_event_id IS NULL
           AND status IN ('summarized', 'transcribed', 'completed')
           AND id NOT IN (
             SELECT source_meeting_id FROM notes WHERE source_meeting_id IS NOT NULL
           )`
      )
      .all() as AdHocMeetingRow[]

    for (const meeting of adHocMeetings) {
      const companyLink = getCompanyLink.get(meeting.id) as { company_id: string } | undefined
      const newId = randomUUID()
      const content = readMeetingContent(meeting.summary_path, meeting.transcript_path)
        || meeting.notes
        || ''

      insertNote.run(
        newId,
        meeting.title ?? null,
        content,
        companyLink?.company_id ?? null,
        meeting.id, // source_meeting_id links back to the original meeting
        meeting.created_by_user_id ?? null,
        meeting.created_by_user_id ?? null,
        meeting.created_at,
        meeting.updated_at
      )
    }

    console.log(`[migration-053] Created ${adHocMeetings.length} companion note(s) for ad-hoc recorded meetings`)

    // Phase 3: Backfill existing companion notes that were created with empty content.
    // This handles notes created before Phase 2 included file-reading. Idempotent:
    // once content is populated, content = '' no longer matches → skip on re-run.
    const emptyCompanionNotes = db
      .prepare(
        `SELECT n.id, m.summary_path, m.transcript_path
         FROM notes n
         JOIN meetings m ON m.id = n.source_meeting_id
         WHERE n.source_meeting_id IS NOT NULL
           AND (n.content IS NULL OR n.content = '')`
      )
      .all() as { id: string; summary_path: string | null; transcript_path: string | null }[]

    const updateContent = db.prepare(`UPDATE notes SET content = ? WHERE id = ?`)

    let backfilled = 0
    for (const row of emptyCompanionNotes) {
      const content = readMeetingContent(row.summary_path, row.transcript_path)
      if (content) {
        updateContent.run(content, row.id)
        backfilled++
      }
    }

    console.log(`[migration-053] Backfilled ${backfilled}/${emptyCompanionNotes.length} companion note(s) with meeting content`)
  })()
}
