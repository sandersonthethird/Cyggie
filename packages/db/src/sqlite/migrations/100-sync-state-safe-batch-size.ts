import type Database from 'better-sqlite3'

/**
 * T38 — adds `safe_batch_size INTEGER` to `sync_state`.
 *
 * The SyncAgent halves its drain batch size on a 413 (FST_ERR_CTP_BODY_TOO_LARGE
 * from the gateway) and persists the new size here so subsequent ticks
 * — and the next process restart — start at the discovered safe ceiling
 * rather than re-discovering it via another 413.
 *
 * NULL means "no ceiling discovered yet"; the agent uses its compiled-in
 * default. Stored as INTEGER so the agent can use plain bigint/number
 * comparisons without parsing.
 *
 * Idempotent — uses information_schema-equivalent check via PRAGMA.
 */
export function runSyncStateSafeBatchSizeMigration(
  db: Database.Database,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(sync_state)`)
    .all() as Array<{ name: string }>
  if (cols.some((c) => c.name === 'safe_batch_size')) return
  db.exec(`ALTER TABLE sync_state ADD COLUMN safe_batch_size INTEGER`)
}
