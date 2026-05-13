import type Database from 'better-sqlite3'

/**
 * Adds a nullable `section` column to `memo_evidence` and re-creates the two
 * UNIQUE indexes so `section` is part of the dedupe key.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Why include section in the UNIQUE index?                         │
 *   │                                                                   │
 *   │  Before: uq_memo_evidence_internal(version_id, claim_text,       │
 *   │                                     source_type, source_id)      │
 *   │          uq_memo_evidence_web     (version_id, claim_text,        │
 *   │                                     source_url)                  │
 *   │                                                                   │
 *   │  The producer agent's cite_source tool now persists the section. │
 *   │  Without section in the key, a claim cited in TWO different       │
 *   │  sections (e.g. "TAM is $50B [src1]" in both Market AND Risks)    │
 *   │  would silently lose the second row to ON CONFLICT IGNORE.        │
 *   │  Adding section to the key preserves per-section attribution.     │
 *   │                                                                   │
 *   │  SQLite treats NULL as distinct in UNIQUE indexes — legacy rows  │
 *   │  with section=NULL won't collide with each other or with new      │
 *   │  rows that have a section value.                                  │
 *   │                                                                   │
 *   │  Idempotency: ALTER TABLE ADD COLUMN fails on duplicate column,  │
 *   │  so we check PRAGMA table_info first. Index recreation uses       │
 *   │  DROP IF EXISTS + CREATE; no-op on re-run.                        │
 *   └──────────────────────────────────────────────────────────────────┘
 */
function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === columnName)
}

export function runMemoEvidenceSectionMigration(db: Database.Database): void {
  if (!columnExists(db, 'memo_evidence', 'section')) {
    db.exec(`ALTER TABLE memo_evidence ADD COLUMN section TEXT`)
  }

  db.exec(`
    DROP INDEX IF EXISTS uq_memo_evidence_internal;
    DROP INDEX IF EXISTS uq_memo_evidence_web;

    CREATE UNIQUE INDEX uq_memo_evidence_internal
      ON memo_evidence(version_id, section, claim_text, source_type, source_id)
      WHERE source_type != 'web';

    CREATE UNIQUE INDEX uq_memo_evidence_web
      ON memo_evidence(version_id, section, claim_text, source_url)
      WHERE source_type = 'web';
  `)
}
