import type Database from 'better-sqlite3'

/**
 * Drop the legacy `company_notes` and `contact_notes` tables.
 *
 * Background: migration 052 ("unified-notes") moved all rows into the unified
 * `notes` table (with nullable `company_id` and `contact_id` FKs). Since then,
 * NO production code path inserts/updates/deletes against the legacy tables —
 * the IPC handlers `COMPANY_NOTES_*` / `CONTACT_NOTES_*` already route to
 * `notes` via `makeEntityNotesRepo(fkCol)` in `notes-base.ts`.
 *
 * Idempotent — `DROP TABLE IF EXISTS` is a no-op on already-dropped tables.
 * Indexes auto-drop with the table.
 */
export function runDropLegacyNotesTablesMigration(db: Database.Database): void {
  // Sanity check: log if any rows exist (they shouldn't — both tables have been
  // unwritten-to since v052). If they do, log the count loudly so it's visible
  // in dev logs; the data is presumed already-mirrored in the unified `notes`
  // table from the v052 conversion, but a non-zero count here would warrant
  // manual investigation before the drop.
  for (const table of ['company_notes', 'contact_notes'] as const) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as
        | { n: number }
        | undefined
      if (row && row.n > 0) {
        console.warn(
          `[migration 081] dropping ${table} with ${row.n} rows — these were never reachable from production code paths after v052`,
        )
      }
    } catch {
      // Table doesn't exist yet — already dropped or never created. Fine.
    }
  }

  db.exec(`
    DROP TABLE IF EXISTS company_notes;
    DROP TABLE IF EXISTS contact_notes;
  `)
}
