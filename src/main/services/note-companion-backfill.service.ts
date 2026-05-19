/**
 * note-companion-backfill.service — meeting-summary companion-note creation.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ Trigger: Notes tab opened on a Company OR Contact detail page    │
 *   │ (via the per-entity IPC handler's `onBeforeList` hook).          │
 *   │                                                                  │
 *   │ Pipeline:                                                        │
 *   │   1. Query meetings linked to entity AND with a summary on disk  │
 *   │   2. For each meeting:                                           │
 *   │        ├─ read summary file (skip + log on miss)                 │
 *   │        └─ findOrCreate companion note keyed on                   │
 *   │           (entity, source_meeting_id) — dedup by app-layer       │
 *   │           query AND defended by the partial UNIQUE indexes       │
 *   │           added in migration 082                                 │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Why this lives in services and not in the IPC files:
 *   - Both company and contact paths share the read-summary + dedup-then-insert
 *     logic. Co-locating prevents drift when one side changes.
 *   - Several non-IPC callers (summarizer, partner-meeting-reconcile,
 *     meeting-notes-backfill) also create source-meeting-bearing notes; they
 *     all funnel through `createMeetingCompanionNote` here so the dedup
 *     guarantee is honored uniformly.
 */

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'
import { listCompanyMeetingSummaryPaths } from '@cyggie/db/sqlite/repositories'
import { readSummary } from '../storage/file-manager'
import type { Note } from '../../shared/types/note'

export type EntityType = 'company' | 'contact'

const companyRepo = makeEntityNotesRepo('company_id')
const contactRepo = makeEntityNotesRepo('contact_id')

/**
 * Idempotent dedup-aware create for meeting-summary companion notes.
 *
 * For a given (entityType, entityId, sourceMeetingId) tuple, this either:
 *  - returns the existing companion note if one is already tagged to that entity
 *  - claims an existing untagged note (company_id/contact_id IS NULL) and tags it
 *  - creates a fresh companion note
 *
 * The migration-082 UNIQUE indexes catch any race that slips past the app-layer
 * check. The constraint failure is caught and logged; the existing note is
 * returned instead of throwing.
 */
export function createMeetingCompanionNote(
  data: {
    entityType: EntityType
    entityId: string
    title?: string | null
    content: string
    sourceMeetingId: string
    themeId?: string | null
  },
  userId: string | null = null,
): Note | null {
  const db = getDatabase()
  const entityCol = data.entityType === 'company' ? 'company_id' : 'contact_id'
  const repo = data.entityType === 'company' ? companyRepo : contactRepo

  // Look for ANY note linked to this meeting (not just ones already tagged to
  // this entity). Three cases:
  //   - linked to same entity → return as-is
  //   - linked to no entity (NULL) → claim by setting the FK
  //   - linked to a DIFFERENT entity (multi-entity meeting) → fall through and
  //     create a separate companion note
  const existing = db
    .prepare(
      `SELECT id, ${entityCol} as entity_id FROM notes WHERE source_meeting_id = ? LIMIT 1`,
    )
    .get(data.sourceMeetingId) as { id: string; entity_id: string | null } | undefined

  if (existing) {
    if (existing.entity_id === data.entityId) return repo.get(existing.id)
    if (existing.entity_id === null) {
      db.prepare(`UPDATE notes SET ${entityCol} = ? WHERE id = ?`).run(
        data.entityId,
        existing.id,
      )
      return repo.get(existing.id)
    }
    // Different entity — fall through to create a separate note.
  }

  try {
    return repo.create(
      {
        entityId: data.entityId,
        themeId: data.themeId,
        title: data.title,
        content: data.content,
        sourceMeetingId: data.sourceMeetingId,
      },
      userId,
    )
  } catch (err) {
    // Race: a parallel call beat us between the SELECT above and INSERT here.
    // Migration 082 adds partial UNIQUE indexes on (entity, source_meeting_id),
    // so the duplicate INSERT fails. Re-fetch and return the winning row.
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('UNIQUE') || message.includes('constraint')) {
      console.warn(
        `[noteCompanionBackfill] UNIQUE collision for ${data.entityType} ${data.entityId} meeting ${data.sourceMeetingId}; returning winner`,
      )
      const winner = db
        .prepare(
          `SELECT id FROM notes WHERE ${entityCol} = ? AND source_meeting_id = ? LIMIT 1`,
        )
        .get(data.entityId, data.sourceMeetingId) as { id: string } | undefined
      return winner ? repo.get(winner.id) : null
    }
    throw err
  }
}

/**
 * Lazy backfill: ensure every summarized meeting linked to this company has a
 * companion note. Called from the COMPANY_NOTES_LIST handler before the list
 * query runs, so freshly-summarized meetings appear in the Notes tab on first
 * open without manual sync.
 */
export function ensureCompanyMeetingSummaryNotes(
  companyId: string,
  userId: string | null,
): void {
  try {
    const rows = listCompanyMeetingSummaryPaths(companyId)
    for (const row of rows) {
      let summary: string | null = null
      try {
        summary = readSummary(row.summaryPath)
      } catch (err) {
        console.warn('[noteCompanionBackfill] Failed to read summary:', err)
        continue
      }
      if (!summary) continue
      const noteTitle = row.title?.trim() || 'Meeting'
      const noteContent = `${noteTitle}\n${summary}`
      createMeetingCompanionNote(
        {
          entityType: 'company',
          entityId: companyId,
          title: noteTitle,
          content: noteContent,
          sourceMeetingId: row.meetingId,
        },
        userId,
      )
    }
  } catch (err) {
    console.error(
      '[noteCompanionBackfill] Failed to backfill company meeting summaries:',
      err,
    )
  }
}

/**
 * Same shape as the company helper, but for contacts.
 *
 * Contact-meeting linkage uses TWO sources (UNION), per the plan's A4 upgrade:
 *
 *   1. `meeting_speaker_contact_links` — explicit speaker tagging in a meeting
 *   2. `contact_emails` JOIN against `meetings.attendee_emails` JSON — catches
 *      attendees who are on the calendar invite but were never speaker-tagged
 *
 * Either source qualifying is enough for backfill (UNION).
 */
export function ensureContactMeetingSummaryNotes(
  contactId: string,
  userId: string | null,
): void {
  try {
    const db = getDatabase()
    const rows = db
      .prepare(`
        SELECT m.id as meetingId, m.title, m.date, m.summary_path as summaryPath
        FROM meetings m
        WHERE m.summary_path IS NOT NULL
          AND m.id IN (
            -- Linkage 1: speaker-tagged in this meeting
            SELECT l.meeting_id
              FROM meeting_speaker_contact_links l
             WHERE l.contact_id = ?
            UNION
            -- Linkage 2: contact's email is in the attendee_emails JSON array
            SELECT m2.id
              FROM meetings m2
             WHERE EXISTS (
                     SELECT 1
                       FROM json_each(COALESCE(m2.attendee_emails, '[]')) e
                       JOIN contact_emails ce
                         ON lower(trim(e.value)) = lower(trim(ce.email))
                      WHERE ce.contact_id = ?
                   )
          )
        ORDER BY datetime(m.date) DESC
      `)
      .all(contactId, contactId) as Array<{
        meetingId: string
        title: string
        date: string
        summaryPath: string
      }>

    for (const row of rows) {
      let summary: string | null = null
      try {
        summary = readSummary(row.summaryPath)
      } catch (err) {
        console.warn('[noteCompanionBackfill] Failed to read summary:', err)
        continue
      }
      if (!summary) continue
      const noteTitle = row.title?.trim() || 'Meeting'
      const noteContent = `${noteTitle}\n${summary}`
      createMeetingCompanionNote(
        {
          entityType: 'contact',
          entityId: contactId,
          title: noteTitle,
          content: noteContent,
          sourceMeetingId: row.meetingId,
        },
        userId,
      )
    }
  } catch (err) {
    console.error(
      '[noteCompanionBackfill] Failed to backfill contact meeting summaries:',
      err,
    )
  }
}
