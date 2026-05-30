import type Database from 'better-sqlite3'

/**
 * Adds `meetings.me_speaker_index` (INTEGER, nullable) to record which
 * Deepgram speaker index belongs to the recording user. Drives the
 * me/them bubble view (Part 3 of the cheeky-treasure transcription plan).
 *
 *   - NULL on pre-migration rows. Render-time resolver falls back to
 *     `findMeSpeakerByName(speakerMap, calendarSelfName)` then
 *     most-talkative.
 *   - On new recordings, RecordingSession.finalize() runs
 *     `resolveMeSpeakerIndex` and persists the result here.
 *   - "Swap Me/Them" button flips this single row; transcript segments
 *     are never mutated.
 *
 * Idempotent — guarded by PRAGMA table_info check.
 */
export function runMeetingsMeSpeakerIndexMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  const hasColumn = cols.some((c) => c.name === 'me_speaker_index')

  if (!hasColumn) {
    db.exec(`ALTER TABLE meetings ADD COLUMN me_speaker_index INTEGER`)
  }
}
