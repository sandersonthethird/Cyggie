import type Database from 'better-sqlite3'

/**
 * Migration 064: Deduplicate calendar_event_id and add a UNIQUE partial index.
 *
 * Background: recording.ipc.ts previously created a new meeting with the same
 * calendar_event_id as an already-transcribed meeting (back-to-back recording bug).
 * This migration cleans up any existing duplicates, then adds a DB-level constraint
 * so the bug cannot recur silently if the application logic is ever changed.
 *
 * Dedup strategy: for each duplicate group, keep the most content-rich meeting
 * (has transcript_path > has notes > oldest created_at). The others have their
 * calendar_event_id nulled out — their data is preserved, only the calendar link
 * is cleared.
 *
 * The UNIQUE constraint uses a partial index (WHERE calendar_event_id IS NOT NULL)
 * so ad-hoc meetings with no calendar event remain unaffected.
 */
export function runCalendarEventDedupMigration(db: Database.Database): void {
  // Find all calendar_event_ids that appear more than once
  const dupes = db.prepare(`
    SELECT calendar_event_id
    FROM meetings
    WHERE calendar_event_id IS NOT NULL
    GROUP BY calendar_event_id
    HAVING COUNT(*) > 1
  `).all() as { calendar_event_id: string }[]

  for (const { calendar_event_id } of dupes) {
    const meetings = db.prepare(`
      SELECT id
      FROM meetings
      WHERE calendar_event_id = ?
      ORDER BY
        CASE WHEN transcript_path IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN notes IS NOT NULL AND notes != '' THEN 0 ELSE 1 END,
        created_at ASC
    `).all(calendar_event_id) as { id: string }[]

    // Keep the first (most content-rich / oldest), clear calendar link on the rest
    const [, ...nullify] = meetings
    for (const { id } of nullify) {
      db.prepare('UPDATE meetings SET calendar_event_id = NULL WHERE id = ?').run(id)
    }
  }

  // Now safe to add the unique index — duplicates have been resolved above
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_meetings_calendar_event_id
    ON meetings(calendar_event_id)
    WHERE calendar_event_id IS NOT NULL
  `)
}
