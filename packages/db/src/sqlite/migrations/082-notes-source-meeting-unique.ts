import type Database from 'better-sqlite3'

/**
 * Add partial UNIQUE indexes on the unified `notes` table to enforce that a
 * given (entity, source_meeting_id) pair has at most one companion note:
 *
 *   UNIQUE (company_id, source_meeting_id) WHERE both NOT NULL
 *   UNIQUE (contact_id, source_meeting_id) WHERE both NOT NULL
 *
 * Background: the legacy `company_notes` / `contact_notes` tables had this
 * constraint at the schema level. The unified `notes` table only had a
 * non-unique index on `source_meeting_id`, so dedup relied entirely on the
 * application layer (the now-removed `createCompanyNote` ran a query-then-
 * insert). This migration moves the guarantee into the schema so any future
 * code path that bypasses the helper still can't produce duplicates.
 *
 * Pre-step: delete pre-existing duplicates (keep the lowest `id`) so the
 * index can be created on dirty data. Logs the cleanup count for visibility.
 *
 * Idempotent — `IF NOT EXISTS` makes index creation safe to re-run; the
 * dedup pre-step is also safe (after a successful run, no duplicates remain).
 */
export function runNotesSourceMeetingUniqueMigration(db: Database.Database): void {
  // Step 1: delete duplicates per (company_id, source_meeting_id), keeping
  // the lowest-id row in each group. Wrap in a transaction so cleanup +
  // index creation happen atomically.
  const apply = db.transaction(() => {
    const dupCompany = db
      .prepare(
        `DELETE FROM notes
         WHERE company_id IS NOT NULL
           AND source_meeting_id IS NOT NULL
           AND id NOT IN (
             SELECT MIN(id) FROM notes
             WHERE company_id IS NOT NULL AND source_meeting_id IS NOT NULL
             GROUP BY company_id, source_meeting_id
           )`,
      )
      .run()
    if (dupCompany.changes > 0) {
      console.warn(
        `[migration 082] removed ${dupCompany.changes} duplicate (company_id, source_meeting_id) note(s) before adding UNIQUE index`,
      )
    }

    const dupContact = db
      .prepare(
        `DELETE FROM notes
         WHERE contact_id IS NOT NULL
           AND source_meeting_id IS NOT NULL
           AND id NOT IN (
             SELECT MIN(id) FROM notes
             WHERE contact_id IS NOT NULL AND source_meeting_id IS NOT NULL
             GROUP BY contact_id, source_meeting_id
           )`,
      )
      .run()
    if (dupContact.changes > 0) {
      console.warn(
        `[migration 082] removed ${dupContact.changes} duplicate (contact_id, source_meeting_id) note(s) before adding UNIQUE index`,
      )
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_company_source_meeting
        ON notes(company_id, source_meeting_id)
        WHERE company_id IS NOT NULL AND source_meeting_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_contact_source_meeting
        ON notes(contact_id, source_meeting_id)
        WHERE contact_id IS NOT NULL AND source_meeting_id IS NOT NULL;
    `)
  })
  apply()
}
