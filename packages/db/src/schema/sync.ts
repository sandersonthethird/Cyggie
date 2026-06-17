import { sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { firms } from './firms'

// Outbox table — populated by desktop sync agent on every owned-row write via
// writeWithSync(table, rowId, fieldUpdates). Single helper at the repository layer
// guarantees no path forgets to enqueue (per plan-eng-review issue 6).
//
//   SYNC AGENT STATE MACHINE (desktop):
//     [IDLE] ──outbox.has_rows──▶ [FLUSHING] ──POST /sync/push──▶ [ACK_PENDING]
//        ▲                                                              │
//        │                                                              │ success
//        │                                                              │
//        │ apply_acks ◀────────────────────────────────────────────────┘
//        │                                                              │ conflict in response
//        │                                                              ▼
//        │                                                       [CONFLICT_REPORT]
//        │                                                       (silent merge)
//        │                                                              │
//        └──────────────────────────────────────────────────────────────┘
//
// Outbox rows are deleted after gateway ack. Hard cap at 50,000 rows — UI surfaces
// "sync paused — investigate gateway connectivity" if approached.
export const outbox = pgTable(
  'outbox',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 64 }).notNull(),
    tableName: varchar('table_name', { length: 64 }).notNull(),
    rowId: text('row_id').notNull(),
    op: varchar('op', { length: 16 }).notNull(), // 'insert' | 'update' | 'delete'
    payload: jsonb('payload').notNull(), // full row state at write time
    lamport: text('lamport').notNull(), // row-level clock at write time
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
  },
  (t) => [
    index('outbox_user_device_idx').on(t.userId, t.deviceId),
    index('outbox_table_row_idx').on(t.tableName, t.rowId),
    index('outbox_created_idx').on(t.createdAt),
  ],
)

// Per-device sync state. Tracks the last lamport clock each device has acknowledged
// pulling from. SSE long-poll on /sync/pull uses this to know where to resume.
export const syncState = pgTable(
  'sync_state',
  {
    deviceId: varchar('device_id', { length: 64 }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    lastPushedLamport: text('last_pushed_lamport').notNull().default('0'),
    lastPulledLamport: text('last_pulled_lamport').notNull().default('0'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sync_state_user_idx').on(t.userId)],
)

// Tombstones (Phase 3 multiplayer) — a firm-scoped, id-keyed registry of HARD-
// purged entities. Written by the admin purge endpoint; the push handler checks
// it and ACKS-AND-DROPS any later write to a purged id (closes the resurrection
// hole — a teammate's in-flight edit arriving after a purge). Pulled (lamport >
// since) so teammates hard-delete the row locally. Gateway-written only — never
// pushed from desktop (so no OWNED_TABLES / outbox path). Distinct from the
// email-keyed contact_tombstones (a separate dedup mechanism).
export const tombstones = pgTable(
  'tombstones',
  {
    entityType: varchar('entity_type', { length: 32 }).notNull(), // 'company' | 'task'
    entityId: text('entity_id').notNull(),
    firmId: text('firm_id')
      .notNull()
      .references(() => firms.id, { onDelete: 'cascade' }),
    purgedByUserId: text('purged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    purgedAt: timestamp('purged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId] }),
    // Firm-scoped incremental pull cursor (mirrors the owned-table lamport index).
    index('tombstones_firm_lamport_idx').on(t.firmId, sql`(${t.lamport}::numeric)`),
  ],
)

// One-time data migration checkpoints. Used by scripts/migrate-sqlite-to-postgres.ts
// to resume after partial failure (per plan-ceo-review Section 2 — auto-fix for
// "data migration partial failure"). Each row tracks one source SQLite table's
// migration status into Postgres.
export const migrationProgress = pgTable(
  'migration_progress',
  {
    sourceTable: varchar('source_table', { length: 64 }).primaryKey(),
    targetTable: varchar('target_table', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(), // 'pending' | 'in_progress' | 'completed' | 'failed'
    rowsMigrated: text('rows_migrated').notNull().default('0'),
    rowsExpected: text('rows_expected'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
)
