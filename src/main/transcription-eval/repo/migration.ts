// EVAL-FEATURE: idempotent migration for the transcription_evaluations table.
//
// Called from src/main/index.ts after DB bootstrap. Rip-out: delete this file,
// drop the call from index.ts, and `DROP TABLE transcription_evaluations` once.
//
// The table is desktop-only (NOT added to packages/db/src/sync/owned-tables.ts)
// so eval results never sync to Neon. No FK on meeting_id so meeting deletion
// never blocks.

import { getDatabase } from '@cyggie/db/sqlite/connection'

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS transcription_evaluations (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  audio_path TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  transcript_text TEXT NOT NULL,
  request_id TEXT,
  duration_ms INTEGER,
  audio_duration_seconds INTEGER,
  estimated_cost_usd REAL,
  error_message TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
`.trim()

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS transcription_evaluations_meeting_idx
  ON transcription_evaluations(meeting_id)
`.trim()

export function runTranscriptionEvalMigration(): void {
  const db = getDatabase()
  db.exec(CREATE_SQL)
  db.exec(CREATE_INDEX_SQL)
}
