import type Database from 'better-sqlite3'

/**
 * Adds the nullable `meetings.enriched_at` column (T3 — gateway enrichment fallback).
 *
 * `enriched_at` marks that a meeting's CRM side-effects (contact sync + company
 * links) have run. Desktop stamps it after `prepareMeetingFromCalendarEvent`
 * enriches, and the gateway-fallback sweep stamps it on Neon when desktop is
 * offline; whoever runs first wins and the other skips. The value syncs both ways
 * (field-LWW), so a gateway-set timestamp pulls down and the desktop guard sees it.
 *
 * TEXT (ISO-8601) to match the other desktop timestamp columns. Idempotent via
 * PRAGMA so re-runs are cheap no-ops. (No `enrich_attempts` here — that's
 * gateway-only sweep bookkeeping and never reaches SQLite.)
 */
export function runMeetingEnrichedAtMigration(db: Database.Database): void {
  const cols = db.pragma('table_info(meetings)') as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'enriched_at')) {
    db.exec(`ALTER TABLE meetings ADD COLUMN enriched_at TEXT`)
  }
}
