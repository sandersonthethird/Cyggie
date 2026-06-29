import { getDatabase } from '@cyggie/db/sqlite/connection'
import { readSummary, readTranscript } from '../storage/file-manager'
import type { Note } from '../../shared/types/note'

const MAX_CONTENT_BYTES = 50_000

/**
 * Lazy-hydrates a companion note's content from the linked meeting's summary or transcript file.
 *
 * Companion notes (source_meeting_id IS NOT NULL) are created with empty content because
 * migrations run before the user's custom storage path is loaded. This function runs at IPC
 * handler time (after full app init) so the storage path is always correct.
 *
 * Idempotent: skips notes that already have content, or have no meeting link.
 * Persists on first hydration so subsequent opens skip the file read.
 */
export function hydrateCompanionNote(note: Note): Note {
  if (!note.sourceMeetingId || note.content.trim()) return note

  const db = getDatabase()
  const meeting = db
    .prepare('SELECT id, summary_path, transcript_path, is_private FROM meetings WHERE id = ?')
    .get(note.sourceMeetingId) as
    | { id: string; summary_path: string | null; transcript_path: string | null; is_private: number | null }
    | undefined

  if (!meeting) return note

  const meetingRef = { id: meeting.id, isPrivate: meeting.is_private === 1 }
  const raw =
    (meeting.summary_path ? readSummary(meeting.summary_path, meetingRef) : null) ??
    (meeting.transcript_path ? readTranscript(meeting.transcript_path, meetingRef) : null)

  if (!raw) return note

  const content = raw.slice(0, MAX_CONTENT_BYTES)
  // Only persist the content — this is an infrastructure read, not a user edit.
  // updated_at must not advance here; it should only change on explicit user edits (NOTES_UPDATE).
  db.prepare('UPDATE notes SET content = ? WHERE id = ?').run(content, note.id)

  return { ...note, content }
}
