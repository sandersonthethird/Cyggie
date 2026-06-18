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
  /**
   * Property names (camelCase, matching the shape the repo's update fn
   * returns — NOT raw SQL column names) on the post-update row whose
   * values can grow large enough to push a sync batch past the gateway's
   * body limit. T38: for `update` ops, the `withSync` wrapper diffs each
   * of these against the pre-update row state and OMITS unchanged values
   * from the outbox payload. The gateway upsert treats missing columns
   * as no-change, so omission is safe.
   *
   * Only meaningful in combination with `WithSyncOpts.captureBeforeUpdate`
   * — the wrapper needs a pre-update snapshot to compare against. Without
   * `captureBeforeUpdate`, declaring `largeColumns` has no effect.
   *
   * Inserts and deletes pass through unchanged (an insert needs the full
   * row to satisfy NOT NULL constraints on Postgres; a delete only carries
   * the PK).
   */
  largeColumns?: readonly string[]
  /**
   * Postgres ON CONFLICT target columns, when the gateway's unique constraint
   * differs from the SQLite `primaryKey`. Defaults to `primaryKey`. Needed for
   * tables whose SQLite PK is column-narrower than the Neon PK — e.g.
   * `user_preferences` is `(key)` in SQLite (single-user) but `(user_id, key)`
   * in Postgres; the gateway stamps `user_id` from the JWT, so the upsert must
   * conflict on `(user_id, key)`. Used only by the gateway `/sync/push` upsert,
   * NOT by `encodeRowId` / the SQLite WHERE (those still use `primaryKey`).
   */
  conflictKey?: readonly string[]
  /**
   * Opt this table into FIELD-LEVEL last-write-wins (vs the default whole-row
   * LWW). When true:
   *   • the desktop `withSync` wrapper diffs the bare pre/post row and stamps a
   *     `field_lamports` map (camelCase col → lamport) onto the outbox payload +
   *     local row (one clock per changed column);
   *   • the gateway push and the desktop pull-apply merge PER COLUMN via the
   *     shared `mergeFieldLww` (`packages/db/src/sync/field-lww.ts`) instead of
   *     replacing the whole row — so concurrent edits to different columns of
   *     the same row both survive.
   *
   * Requires the table to have a `field_lamports` column (JSONB on Postgres,
   * JSON TEXT on SQLite). Tables without this flag keep whole-row LWW unchanged.
   * Rolled out per-table; `org_companies` is the Phase 1 tracer.
   */
  fieldLww?: boolean
  /**
   * Opt this table into the FIRM-SHARED pool. When true:
   *   • the table has a denormalized `firm_id` column; the gateway stamps it
   *     from the JWT on push (same defense-in-depth as `user_id`), and
   *   • `/sync/pull` scopes by `firm_id = me.firm_id` (instead of
   *     `user_id = me.sub`) — so teammates see each other's rows.
   *
   * Rolled out per-table; `org_companies` is the Phase 1 tracer. Tables without
   * this flag stay user-scoped (private to the owner's devices). Privacy-opt-out
   * tables (contacts/meetings) additionally carry `is_private` + an owner-aware
   * pull predicate (later phases).
   */
  firmScoped?: boolean
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
  // Part E — user preferences (e.g. emailThreadsPerCompany cap). SQLite PK is
  // global `key` (single-user desktop, no user_id column); hasUserId:true makes
  // the gateway stamp user_id from JWT before validating, matching the
  // investment_memos / email_messages pattern. Writes emit via the pref-sync
  // backfill (setPreference is raw SQL), not withSync.
  { table: 'user_preferences', primaryKey: ['key'], hasUserId: true, conflictKey: ['user_id', 'key'] },

  // ── Layer 2 ────────────────────────────────────────────────────────────
  { table: 'pipeline_stages', primaryKey: ['id'], hasUserId: false },
  // Phase 1 multiplayer tracer — field-level LWW so two partners editing
  // different fields of the same company don't clobber each other.
  {
    table: 'org_companies',
    primaryKey: ['id'],
    hasUserId: true,
    fieldLww: true,
    firmScoped: true,
  },

  // ── Layer 3 ────────────────────────────────────────────────────────────
  { table: 'org_company_aliases', primaryKey: ['id'], hasUserId: false },
  // Phase 4 multiplayer — contacts are firm-shared (whole-row LWW) with an
  // is_private owner-only opt-out enforced by entityVisibilityFilter on the pull.
  // Whole-row LWW for V1 (field-LWW for contacts + meetings is a documented
  // follow-up — the field_lamports column is in place for it). firmScoped stamps
  // firm_id from the JWT on push.
  { table: 'contacts', primaryKey: ['id'], hasUserId: true, firmScoped: true },
  // Investment memos — added 2026-05-23 to unblock the mobile Memos tab on
  // company detail. SQLite table lacks user_id (created_by_user_id only),
  // matching the notes pattern — hasUserId: true makes the gateway stamp
  // user_id from JWT.sub before validating the payload.
  { table: 'investment_memos', primaryKey: ['id'], hasUserId: true },
  // Phase 3 — flagged-file extraction. SQLite migration 104 added user_id
  // (nullable, backfilled by the desktop extraction worker on first run).
  // extractedText is the only large column: typical PDF/Drive payload is
  // 10-100K chars; status-only updates (pending → extracting → done)
  // shouldn't re-send the text body, so T38 trim-on-update fires here.
  {
    table: 'company_flagged_files',
    primaryKey: ['id'],
    hasUserId: true,
    largeColumns: ['extractedText'],
  },
  // Custom fields — definitions (parent) before values (child references a
  // definition via field_definition_id). Both SQLite tables use a single `id`
  // PK (a UNIQUE(field_definition_id, entity_id) gives the natural upsert key)
  // and lack a user_id column — hasUserId:true makes the gateway stamp user_id
  // from JWT.sub before validating, matching the investment_memos pattern.
  // Writes flow through the wrapped barrel exports; pre-existing rows are
  // enqueued by custom-field-sync-backfill.service.ts (lamport='0' sentinel).
  { table: 'custom_field_definitions', primaryKey: ['id'], hasUserId: true },
  { table: 'custom_field_values', primaryKey: ['id'], hasUserId: true },

  // ── Layer 4 ────────────────────────────────────────────────────────────
  // contact_emails uses composite (contact_id, email).
  { table: 'contact_emails', primaryKey: ['contact_id', 'email'], hasUserId: false },
  // investment_memo_versions — append-only child of investment_memos.
  // Lamport stored but never compared (UNIQUE(memo_id, version_number)
  // gives natural dedup); the field exists only because the sync protocol
  // requires every owned-table row to carry one.
  { table: 'investment_memo_versions', primaryKey: ['id'], hasUserId: false },
  {
    table: 'meetings',
    primaryKey: ['id'],
    hasUserId: true,
    // Phase 4 multiplayer — meetings are firm-shared with an is_private
    // owner-only opt-out (enforced by entityVisibilityFilter). WHOLE-ROW LWW
    // (NOT field-LWW): meetings are single-author recordings, and the apply path
    // has bespoke calendar-reconcile + transcript-COALESCE logic that a dynamic
    // field-LWW rewrite would jeopardize for little gain. (Contacts ARE field-LWW
    // — collaboratively enriched.) Field-LWW for meetings is a documented follow-up.
    firmScoped: true,
    // T38: meetings carry the largest JSONB columns in the schema. A
    // single transcriptSegments array can run to several MB; chatMessages
    // and summary grow over the meeting's lifetime. Most updates touch
    // none of them (title rename, status flip, etc.), so trimming them
    // out of the outbox payload when unchanged keeps batches small.
    largeColumns: ['transcriptSegments', 'chatMessages', 'summary', 'notes'],
  },

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
  // Phase 2 multiplayer — tasks are firm-shared with field-level LWW (same as
  // org_companies). hasUserId stays true (PG tasks.user_id is NOT NULL; the
  // gateway stamps it from JWT.sub — SQLite tasks has no user_id column).
  { table: 'tasks', primaryKey: ['id'], hasUserId: true, fieldLww: true, firmScoped: true },
  { table: 'chat_sessions', primaryKey: ['id'], hasUserId: true },
  { table: 'chat_session_messages', primaryKey: ['id'], hasUserId: false },

  // ── Lean email sync (Part B) ─────────────────────────────────────────────
  // Three of the nine desktop email tables, synced so the gateway chat context
  // (mobile / web) can include tagged-email correspondence at parity with the
  // desktop-local chat. Email-ingest writes raw SQL (not via wrapped repos),
  // so these rows are enqueued by email-sync-backfill.service.ts (lamport='0'
  // sentinel, like memos), which ALSO truncates body_text to ~12 KB before
  // emit — raw bodies never reach Neon.
  //
  // email_messages: SQLite table has no user_id column (single-user desktop);
  // hasUserId:true makes the gateway stamp user_id from JWT.sub before
  // validating, matching the investment_memos pattern. The link tables scope
  // via their parent message + company/contact (hasUserId:false), like
  // meeting_company_links.
  //
  // FK order: messages before links (links reference email_messages.id).
  // body_text is the only large column (capped at emit; status updates are
  // n/a — email rows are insert-only from ingest's perspective).
  {
    table: 'email_messages',
    primaryKey: ['id'],
    hasUserId: true,
    largeColumns: ['bodyText'],
  },
  { table: 'email_company_links', primaryKey: ['message_id', 'company_id'], hasUserId: false },
  { table: 'email_contact_links', primaryKey: ['message_id', 'contact_id'], hasUserId: false },
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
