import type Database from 'better-sqlite3'

export function runPartnerMeetingMigration(db: Database.Database): void {
  /*
   * Tables:
   *
   *   partner_meeting_digests
   *     One row per weekly digest (active or archived).
   *     Only one 'active' digest at a time — enforced by partial UNIQUE index.
   *     dismissed_suggestions: JSON string[] of company IDs dismissed from the
   *     suggestions banner for this digest week.
   *
   *   partner_meeting_items
   *     One row per agenda item (company or admin) in a digest.
   *     Company items: UNIQUE(digest_id, company_id) — one entry per company.
   *     Admin items: company_id IS NULL — UNIQUE constraint doesn't fire for NULLs,
   *       so each INSERT creates a new admin item (intentional).
   *     position: REAL for fractional indexing (DnD-ready).
   *     brief: AI-generated company brief (TipTap markdown).
   *     meeting_notes: live notes taken during the Tuesday meeting (TipTap markdown).
   */

  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_meeting_digests (
      id                    TEXT PRIMARY KEY,
      week_of               TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'active',
      dismissed_suggestions TEXT NOT NULL DEFAULT '[]',
      archived_at           TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    )
  `)
  console.log('[migration-059] Created partner_meeting_digests table')

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_meeting_active
      ON partner_meeting_digests(status) WHERE status = 'active'
  `)
  console.log('[migration-059] Created idx_partner_meeting_active index')

  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_meeting_items (
      id             TEXT PRIMARY KEY,
      digest_id      TEXT NOT NULL REFERENCES partner_meeting_digests(id) ON DELETE CASCADE,
      company_id     TEXT REFERENCES org_companies(id) ON DELETE CASCADE,
      section        TEXT NOT NULL,
      position       REAL NOT NULL,
      title          TEXT,
      brief          TEXT,
      status_update  TEXT,
      meeting_notes  TEXT,
      is_discussed   INTEGER NOT NULL DEFAULT 0,
      carry_over     INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      UNIQUE(digest_id, company_id)
    )
  `)
  console.log('[migration-059] Created partner_meeting_items table')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pmi_digest_section
      ON partner_meeting_items(digest_id, section, position)
  `)
  console.log('[migration-059] Created idx_pmi_digest_section index')
}
