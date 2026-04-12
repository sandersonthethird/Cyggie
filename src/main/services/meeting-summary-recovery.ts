/**
 * Recovers a meeting summary from its companion notes when the summary file is missing.
 *
 * Background:
 *   When a meeting is enhanced, the summary is saved to a file (summaryPath) AND
 *   cross-saved as a note entry (notes.source_meeting_id = meetingId) for each
 *   linked company and contact. The companion note stores:
 *     "<meeting title>\n<summary content>"
 *
 *   If the summary file is subsequently lost or summaryPath is null, this function
 *   recovers the summary from the first non-empty companion note by stripping the
 *   title line. It also repairs the DB (writes a new summary file + updates summaryPath)
 *   so that future loads skip recovery.
 *
 * Data flow:
 *
 *   meeting (status='summarized', summaryPath=null)
 *        │
 *        ▼
 *   query notes WHERE source_meeting_id = meeting.id AND TRIM(content) != ''
 *        │
 *        ├─ no rows → return null
 *        │
 *        └─ row found
 *             │
 *             ├─ content has '\n' → strip first line (title) → recovered
 *             └─ content has no '\n' → use full content as recovered
 *                  │
 *                  ▼
 *             writeSummary() → new file
 *             updateMeeting({ summaryPath }) → repair DB
 *                  │
 *                  ▼
 *             return recovered (string)
 *
 * If anything throws (disk full, bad path, DB error), logs a warning and returns null
 * so the caller degrades gracefully rather than crashing.
 */

import { getDatabase } from '../database/connection'
import { writeSummary } from '../storage/file-manager'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { getCurrentUserId } from '../security/current-user'
import type { Meeting } from '../../shared/types/meeting'

export function recoverSummaryFromCompanionNote(meeting: Meeting): string | null {
  try {
    const db = getDatabase()
    const row = db
      .prepare(
        "SELECT content FROM notes WHERE source_meeting_id = ? AND TRIM(content) != '' ORDER BY created_at ASC LIMIT 1"
      )
      .get(meeting.id) as { content: string } | undefined

    if (!row?.content) return null

    const firstNewline = row.content.indexOf('\n')
    const recovered = (firstNewline >= 0
      ? row.content.slice(firstNewline + 1)
      : row.content
    ).trim()

    if (!recovered) return null

    // Repair: write summary file + update DB so future loads skip recovery
    const newSummaryPath = writeSummary(meeting.id, recovered, meeting.title, meeting.date, meeting.attendees)
    meetingRepo.updateMeeting(meeting.id, { summaryPath: newSummaryPath }, getCurrentUserId())

    console.log('[SummaryRecovery] Recovered summary from companion note for meeting:', meeting.id)
    return recovered
  } catch (err) {
    console.warn('[SummaryRecovery] Failed to recover summary for meeting:', meeting.id, err)
    return null
  }
}
