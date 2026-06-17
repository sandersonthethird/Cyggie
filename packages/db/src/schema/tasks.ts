import { sql } from 'drizzle-orm'
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { firms } from './firms'
import { orgCompanies } from './companies'
import { contacts } from './contacts'
import { meetings } from './meetings'

// Tasks — action items from meeting summaries, manually-created TODOs, etc.
// Consolidates source migrations: 031 (initial), 095 (priority field rename).
//
// Mobile relevance: Summary screen (WIREFRAME 5) shows pre-checked action items
// auto-assigned to the user. Notes editor (WIREFRAME 6) has checkbox toggle.
export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    // Attachment points (set-null on delete — task survives if linked entity removed).
    meetingId: text('meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    companyId: text('company_id').references(() => orgCompanies.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 32 }).notNull().default('open'),
    category: varchar('category', { length: 32 }).notNull().default('action_item'),
    priority: varchar('priority', { length: 32 }),
    assignee: text('assignee'),
    dueDate: timestamp('due_date', { withTimezone: true }),
    // 'manual' | 'extracted' | 'imported' — how this task entered the system.
    source: varchar('source', { length: 32 }).notNull().default('manual'),
    sourceSection: text('source_section'),
    // Dedup key — extracted tasks may be re-extracted on summary re-run; hash matches
    // prevent dupes.
    extractionHash: text('extraction_hash'),
    // Multiplayer (Phase 2) — firm-shared pool + field-level LWW + soft-delete.
    // Mirrors org_companies (Phase 1). firm_id denormalized so the firm-scoped
    // pull filters without a users JOIN; stamped by the gateway from the JWT on
    // every push, backfilled from the creator's users.firm_id (tasks has no
    // user_id-derived owner column, so the backfill keys on created_by_user_id).
    firmId: text('firm_id').references(() => firms.id, { onDelete: 'cascade' }),
    // Per-column logical clocks (snake_case col → lamport). NULL until the first
    // field-LWW write, then densified. See sync/field-lww.ts.
    fieldLamports: jsonb('field_lamports'),
    // Soft-delete: a user delete sets these (an UPDATE that syncs like any edit);
    // reads filter deleted_at IS NULL. Hard purge (admin) is a separate path.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedByUserId: text('deleted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tasks_user_idx').on(t.userId),
    // Firm-scoped pull cursor (L1): WHERE firm_id = ? AND lamport::numeric > ?.
    // Expression index keeps the numeric cast from forcing a seq-scan + sort.
    index('tasks_firm_lamport_idx').on(t.firmId, sql`(${t.lamport}::numeric)`),
    // Recycle-bin scan: deleted-but-recoverable rows, partial to stay tiny.
    index('tasks_recycle_idx')
      .on(t.firmId, t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    index('tasks_meeting_idx').on(t.meetingId),
    index('tasks_company_idx').on(t.companyId),
    index('tasks_contact_idx').on(t.contactId),
    index('tasks_status_idx').on(t.status),
    index('tasks_due_date_idx').on(t.dueDate),
    index('tasks_extraction_hash_idx').on(t.extractionHash),
  ],
)
