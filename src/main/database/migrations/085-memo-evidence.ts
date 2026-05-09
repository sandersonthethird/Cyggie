import type Database from 'better-sqlite3'

/**
 * Sidecar table that records the structured evidence rows the memo generator
 * and stress-test agent produce alongside the markdown memo. Each row anchors
 * a claim in the rendered memo to a specific source — internal (meeting,
 * note, email, drive file, contact) or web — with a snippet, confidence,
 * and (for critique-type rows) severity. Powers hover-to-evidence,
 * confidence chips, and the critique heatmap.
 *
 * `claim_text` is the substring of memo markdown to anchor evidence to (Phase 1
 * uses fuzzy substring match for hover lookup; Phase 2 will swap to a stable
 * `claim_id` via a `claims` table).
 *
 * `source_id` is nullable for web sources (their identity is the URL).
 * `source_url` is non-null for web; nullable for internal sources.
 *
 * Dedupe is split across two partial unique indexes — one keyed on
 * `source_id` for internal rows, one keyed on `source_url` for web rows.
 * A single UNIQUE(...) over all five columns would not dedupe correctly because
 * SQLite treats NULLs as distinct in UNIQUE constraints (so two internal rows
 * with the same source_id but NULL source_url would not collide).
 */
export function runMemoEvidenceMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memo_evidence (
      id              TEXT PRIMARY KEY,
      version_id      TEXT NOT NULL,
      claim_text      TEXT NOT NULL,
      claim_category  TEXT,                              -- market | team | traction | risk | competition | general
      source_type     TEXT NOT NULL,                     -- meeting | note | email | drive_file | web | contact
      source_id       TEXT,
      source_url      TEXT,
      snippet         TEXT NOT NULL,
      confidence      TEXT NOT NULL,                     -- high | medium | low
      severity        TEXT,                              -- only for critique items: high | medium | low
      is_critique     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (version_id) REFERENCES investment_memo_versions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_memo_evidence_version ON memo_evidence(version_id);
    CREATE INDEX IF NOT EXISTS idx_memo_evidence_source  ON memo_evidence(source_type, source_id);
    -- Split dedupe by source category: internal sources key on source_id;
    -- web sources key on source_url. SQLite treats NULL as distinct in UNIQUE,
    -- so a single multi-column UNIQUE wouldn't fire for either category.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memo_evidence_internal
      ON memo_evidence(version_id, claim_text, source_type, source_id)
      WHERE source_type != 'web';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_memo_evidence_web
      ON memo_evidence(version_id, claim_text, source_url)
      WHERE source_type = 'web';
  `)
}
