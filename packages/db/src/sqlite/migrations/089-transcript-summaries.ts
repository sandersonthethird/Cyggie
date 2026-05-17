import type Database from 'better-sqlite3'

/**
 * Cache for Haiku-generated transcript summaries used by the memo producer
 * agent's context budget manager.
 *
 * When a memo run's full transcripts exceed the recent-transcripts budget,
 * the oldest raw transcripts are displaced to summarized form via a cheap
 * Haiku call. The result is cached keyed on the transcript file's path AND
 * content hash so:
 *   - Re-running the same memo doesn't re-pay the Haiku cost
 *   - Edits to the transcript invalidate the cache (different hash → miss)
 *
 * Storage: ~1-2 KB per summary; rows persist indefinitely. Each transcript
 * has at most a few entries (one per content version) so volume is small.
 */
export function runTranscriptSummariesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_summaries (
      transcript_path TEXT NOT NULL,
      content_hash    TEXT NOT NULL,
      summary         TEXT NOT NULL,
      token_count     INTEGER NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (transcript_path, content_hash)
    );
  `)
}
