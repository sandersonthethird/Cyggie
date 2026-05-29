import type Database from 'better-sqlite3'

/**
 * Adds `meetings.transcript_provider` (TEXT, nullable) to record which
 * live transcription provider produced each transcript. Populated by
 * RecordingSession on finalize.
 *
 * Also performs the one-time cleanup of orphaned `mistralApiKey` rows in
 * the settings table — the Voxtral evaluation provider was removed
 * 2026-05-28 and any encrypted blob stored under that key is now dead
 * weight.
 *
 * Why both in one migration: both are tiny, one-shot, and tied to the
 * 2026-05-28 transcription provider picker rollout. Keeping them together
 * means one IF NOT EXISTS check rather than two.
 *
 * Idempotent — guarded by a PRAGMA table_info check on the column add.
 * The settings DELETE is naturally idempotent (no rows = no work).
 */
export function runMeetingsTranscriptProviderMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  const hasColumn = cols.some((c) => c.name === 'transcript_provider')

  if (!hasColumn) {
    db.exec(`ALTER TABLE meetings ADD COLUMN transcript_provider TEXT`)
  }

  // Wipe orphan Mistral API key (was 'mistralApiKey' for the Voxtral
  // evaluator; provider removed 2026-05-28). Safe to run on every boot —
  // hits a single key by name. The encrypted blob was never used for
  // anything outside the eval window.
  db.exec(`DELETE FROM settings WHERE key = 'mistralApiKey'`)
}
