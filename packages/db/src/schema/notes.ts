import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { orgCompanies } from './companies'
import { contacts } from './contacts'
import { meetings } from './meetings'
import { themes } from './themes'

// =============================================================================
// NOTES — unified notes table. Architectural keystone introduced by migration 052
// which replaced the separate company_notes + contact_notes tables. One row per
// note; (company_id, contact_id, theme_id, source_meeting_id) form the optional
// attachment points. Consolidates source migrations:
//   052 (unified table), 053 (convert manual notes — repair), 054 (FTS),
//   057 (folder_path), 058 (note_folders table), 082 (source-meeting unique).
//
// FTS5 source table → tsvector + GIN. The desktop's FTS triggers (notes_fts_insert,
// notes_fts_delete, notes_fts_update) are replaced by a single tsvector column with
// a Postgres trigger that keeps it in sync — or by an expression-based GIN index on
// to_tsvector(title || ' ' || content). For V1 we use the latter (no trigger needed,
// query expression handles it). The repository's universal search query becomes:
//   SELECT … FROM notes WHERE to_tsvector('english', coalesce(title,'') || ' ' || content) @@ plainto_tsquery($1)
// =============================================================================

export const notes = pgTable(
  'notes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    content: text('content').notNull().default(''),
    // Optional attachment points — a note can attach to a company, a contact, a meeting,
    // a theme, or none (a "standalone" note in the Notes tab of the wireframes).
    companyId: text('company_id').references(() => orgCompanies.id, { onDelete: 'set null' }),
    contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    sourceMeetingId: text('source_meeting_id').references(() => meetings.id, { onDelete: 'set null' }),
    themeId: text('theme_id').references(() => themes.id, { onDelete: 'set null' }),
    isPinned: integer('is_pinned').notNull().default(0),
    // Hierarchical organization (migrations 057, 058)
    folderPath: text('folder_path'),
    // Provenance of imported notes (Granola, Google Docs, etc.)
    importSource: text('import_source'),
    // Link to partner-meeting-digest item (for "this note came from the digest")
    sourceDigestId: text('source_digest_id'),
    // Audit + sync
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notes_user_idx').on(t.userId),
    index('notes_company_idx').on(t.companyId),
    index('notes_contact_idx').on(t.contactId),
    index('notes_updated_idx').on(t.updatedAt),
    index('notes_folder_path_idx').on(t.folderPath),
    index('notes_import_source_idx').on(t.importSource),
    index('notes_source_meeting_idx').on(t.sourceMeetingId),
    // Partial UNIQUE: one note per (company, source_meeting) pair (migration 082, mobile-aligned).
    uniqueIndex('notes_company_source_meeting_idx')
      .on(t.companyId, t.sourceMeetingId)
      .where(sql`${t.companyId} IS NOT NULL AND ${t.sourceMeetingId} IS NOT NULL`),
    // Partial UNIQUE: one note per (contact, source_meeting) pair.
    uniqueIndex('notes_contact_source_meeting_idx')
      .on(t.contactId, t.sourceMeetingId)
      .where(sql`${t.contactId} IS NOT NULL AND ${t.sourceMeetingId} IS NOT NULL`),
    // Untagged notes (no company or contact) — common filter on the Notes tab.
    index('notes_untagged_idx')
      .on(t.updatedAt)
      .where(sql`${t.companyId} IS NULL AND ${t.contactId} IS NULL`),
    // Partner-meeting digest linkage.
    index('notes_company_source_digest_idx')
      .on(t.companyId, t.sourceDigestId)
      .where(sql`${t.sourceDigestId} IS NOT NULL`),
    // Full-text search via GIN on a computed tsvector expression.
    // Postgres: CREATE INDEX … USING GIN (to_tsvector('english', …)).
    index('notes_fts_idx').using('gin', sql`to_tsvector('english', coalesce(${t.title}, '') || ' ' || ${t.content})`),
  ],
)

// Hierarchical folder paths (migration 058). Plain table — paths are slash-separated
// strings ("Investments/AI Infrastructure/Init Labs"). Acts as a soft constraint:
// the application checks folder_path exists in this table before allowing a note
// to use it.
export const noteFolders = pgTable('note_folders', {
  path: text('path').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  lamport: text('lamport').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
