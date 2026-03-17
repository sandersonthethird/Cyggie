import type Database from 'better-sqlite3'

export function runBackfillNormalizedNamesMigration(db: Database.Database): void {
  // Backfill normalized_name for contacts where it is empty string.
  // The NOT NULL constraint (migration 012) prevents NULL, but empty string is allowed
  // and causes listSuspectedDuplicateContacts to silently exclude those contacts.
  // Uses LOWER(TRIM(full_name)) — matches the normalization in migration 019.
  db.exec(`
    UPDATE contacts
    SET normalized_name = LOWER(TRIM(full_name))
    WHERE TRIM(normalized_name) = ''
      AND full_name IS NOT NULL
      AND TRIM(full_name) <> '';
  `)
}
