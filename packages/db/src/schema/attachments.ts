import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { users } from './auth'
import { firms } from './firms'

// =============================================================================
// ATTACHMENTS — metadata for note/memo inline images + PDF attachments.
//
// The BYTES live in Cloudflare R2 (out-of-band via presigned URLs); only these
// small metadata rows sync. A reference inside note/memo markdown is
// `cyggie-attachment://{id}`, resolved by the desktop protocol handler through
// `storage_key` to a local cache (downloaded from R2 on miss).
//
// SYNC: firmScoped owned table. The gateway stamps `user_id` AND `firm_id` from
// JWT on push (the desktop SQLite carries user_id but no firm_id — single-firm);
// /sync/pull firm-scopes so a teammate can resolve an attachment referenced from
// a firm-shared note/memo. Insert + soft-delete only → whole-row LWW.
//
//   owner_type/owner_id — 'note'|'memo' + notes.id|investment_memos.id
//   storage_key         — R2 object key, 'attachments/{userId}/{id}'
//   checksum            — sha256 hex (integrity check on download)
//   kind                — 'image' | 'pdf'
// =============================================================================

export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    ownerType: text('owner_type').notNull(),
    ownerId: text('owner_id').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // Denormalized firm (stamped from JWT on push) so /sync/pull can firm-scope
    // and the download-url route can authorize by firm membership.
    firmId: text('firm_id').references(() => firms.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storageKey: text('storage_key').notNull(),
    checksum: text('checksum'),
    width: integer('width'),
    height: integer('height'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft-delete (cross-device replication). A removed attachment becomes an
    // UPDATE setting this + bumping lamport, riding the normal owned-table pull.
    // R2 object reclamation happens only AFTER this tombstone propagates (PR3).
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    lamport: text('lamport').notNull().default('0'),
  },
  (t) => [
    index('attachments_owner_idx').on(t.ownerType, t.ownerId),
    index('attachments_firm_idx').on(t.firmId),
    index('attachments_user_idx').on(t.userId),
  ],
)
