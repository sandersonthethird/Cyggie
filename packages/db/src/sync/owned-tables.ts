// =============================================================================
// owned-tables.ts — single source of truth for the desktop sync engine.
//
// Every table the desktop "owns" (i.e. that gets propagated to Neon Postgres
// via the SyncAgent) is enumerated here. Two consumers:
//
//   1. The live SyncAgent — uses `OWNED_TABLES` to know which tables to
//      subscribe to via better-sqlite3's update_hook and which primary key
//      columns to encode into `outbox.row_id` (composite PKs need JSON
//      encoding; see `encode-row-id.ts`).
//
//   2. Backfill paths — both the one-off `scripts/migrate-sqlite-to-postgres`
//      seed tool and the SyncAgent's SYNC_RESET handler iterate via
//      `iterateOwnedTablesInFkOrder` so they walk rows in a consistent FK
//      dependency order (parents before children) and never produce a
//      reference to a row that hasn't landed yet on the receiving side.
//
// Two things the registry deliberately does NOT track:
//   • Read-only or cache tables (FTS indexes, transcript_summaries, agent_runs).
//     These exist locally only and never propagate.
//   • Non-V1 tables (custom_fields, decision_logs, partner_meeting_digests,
//     deals, memos, etc.) — pulled in as those domains land in mobile.
//
// When adding a new owned table:
//   1. Add a `TableSpec` here, in FK dependency order.
//   2. Add a drizzle-zod write schema in `packages/db/src/postgres/write-validators.ts`.
//   3. Confirm the SQLite migration adds `lamport TEXT NOT NULL DEFAULT '0'`.
//
// FK dependency order is derived from `scripts/migrate-sqlite-to-postgres/
// migrators.ts allMigrators()`. When that file is retired in favor of the
// shared iterator (post-1.5a), keep both in sync until the migrators file is
// removed.
// =============================================================================

export interface OwnedTableSpec {
  /** SQLite table name (and, by convention, also the Postgres name). */
  table: string
  /**
   * Primary key column names in canonical order. Single-key tables list one
   * column (usually 'id'). Composite-PK tables list every key column —
   * `encode-row-id.ts` uses this to build a deterministic JSON-encoded
   * identifier that maps to a single TEXT in `outbox.row_id`.
   */
  primaryKey: readonly string[]
  /**
   * True when the SQLite table has a `user_id` column we can filter by during
   * backfill iteration. False for join tables that don't carry user_id
   * directly — their scoping derives from the parent table's user_id
   * (e.g. `meeting_company_links` is scoped via `meetings.user_id`).
   *
   * In V1 the SQLite database is single-user, so this flag is mostly cosmetic
   * (the iterator filter is a defense-in-depth). It becomes load-bearing in
   * a future multi-user-on-desktop world.
   */
  hasUserId: boolean
}

// Order matters: parents before children. Matches `allMigrators()`.
//
//   Layer 1 (no inbound FKs)        — templates, themes, pipeline_configs, speakers
//   Layer 2 (depends on layer 1)    — pipeline_stages, org_companies
//   Layer 3 (depends on layer 2)    — org_company_aliases, contacts
//   Layer 4 (depends on layer 3)    — contact_emails, meetings
//   Layer 5 (depends on layer 4)    — meeting_*, notes, note_folders, tasks,
//                                     chat_sessions, chat_session_messages
export const OWNED_TABLES: readonly OwnedTableSpec[] = [
  // ── Layer 1 ────────────────────────────────────────────────────────────
  { table: 'templates', primaryKey: ['id'], hasUserId: true },
  { table: 'themes', primaryKey: ['id'], hasUserId: true },
  { table: 'pipeline_configs', primaryKey: ['id'], hasUserId: true },
  { table: 'speakers', primaryKey: ['id'], hasUserId: true },

  // ── Layer 2 ────────────────────────────────────────────────────────────
  { table: 'pipeline_stages', primaryKey: ['id'], hasUserId: false },
  { table: 'org_companies', primaryKey: ['id'], hasUserId: true },

  // ── Layer 3 ────────────────────────────────────────────────────────────
  { table: 'org_company_aliases', primaryKey: ['id'], hasUserId: false },
  { table: 'contacts', primaryKey: ['id'], hasUserId: true },

  // ── Layer 4 ────────────────────────────────────────────────────────────
  // contact_emails uses composite (contact_id, email).
  { table: 'contact_emails', primaryKey: ['contact_id', 'email'], hasUserId: false },
  { table: 'meetings', primaryKey: ['id'], hasUserId: true },

  // ── Layer 5 ────────────────────────────────────────────────────────────
  { table: 'meeting_speakers', primaryKey: ['meeting_id', 'speaker_index'], hasUserId: false },
  { table: 'meeting_company_links', primaryKey: ['meeting_id', 'company_id'], hasUserId: false },
  {
    table: 'meeting_speaker_contact_links',
    primaryKey: ['meeting_id', 'speaker_index'],
    hasUserId: false,
  },
  { table: 'notes', primaryKey: ['id'], hasUserId: true },
  { table: 'note_folders', primaryKey: ['path'], hasUserId: true },
  { table: 'tasks', primaryKey: ['id'], hasUserId: true },
  { table: 'chat_sessions', primaryKey: ['id'], hasUserId: true },
  { table: 'chat_session_messages', primaryKey: ['id'], hasUserId: false },
] as const

/**
 * Fast O(1) lookup of the spec for a given table name. Used by the
 * SyncAgent's update_hook callback (called on every row mutation) and by
 * `encode-row-id.ts`. Building this once at module load is cheaper than
 * scanning the array per call — the hook fires thousands of times per
 * second during transcript writes.
 */
export const OWNED_TABLES_BY_NAME: ReadonlyMap<string, OwnedTableSpec> = new Map(
  OWNED_TABLES.map((spec) => [spec.table, spec]),
)

/** Returns true if `tableName` is sync-tracked. Used by the update_hook filter. */
export function isOwnedTable(tableName: string): boolean {
  return OWNED_TABLES_BY_NAME.has(tableName)
}

/**
 * Minimal SQLite handle shape the iterator needs. Avoids pulling in
 * better-sqlite3 types here so this file is consumable from the migration
 * script (which uses `node:sqlite`) and from desktop main (which uses
 * better-sqlite3). Both expose a `prepare(sql).iterate()` API with the same
 * iteration semantics.
 */
export interface MinimalSqliteDb {
  prepare(sql: string): {
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>
  }
}

/**
 * Iterates every row of every owned table in FK-dependency order, scoped to
 * a single user. Yields `{ spec, row }` pairs so callers can decide what to
 * do with each row.
 *
 * Used by:
 *   • The migration script (Step 0 seed) — collects rows into batches and
 *     bulk-inserts to Postgres.
 *   • The SyncAgent's SYNC_RESET handler — enqueues an outbox entry per
 *     row so they flow through the live `/sync/push` path.
 *
 * Tables that have `hasUserId` filter by `WHERE user_id = ?`. Join tables
 * without `user_id` include all rows — they're scoped via their parent's
 * user_id, which is sufficient for V1 single-user SQLite. A future
 * multi-user-on-desktop world will need parent-aware JOINs here.
 */
export function* iterateOwnedTablesInFkOrder(
  db: MinimalSqliteDb,
  userId: string,
): Generator<{ spec: OwnedTableSpec; row: Record<string, unknown> }> {
  for (const spec of OWNED_TABLES) {
    const sql = spec.hasUserId
      ? `SELECT * FROM ${spec.table} WHERE user_id = ?`
      : `SELECT * FROM ${spec.table}`
    const stmt = db.prepare(sql)
    const args = spec.hasUserId ? [userId] : []
    for (const row of stmt.iterate(...args)) {
      yield { spec, row }
    }
  }
}
