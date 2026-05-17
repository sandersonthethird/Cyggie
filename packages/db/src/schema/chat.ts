import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'

// Chat sessions + messages. Consolidates migrations 078 (sessions+messages+FTS),
// 080 (backfill meeting chats — repair script).
//
// **Mobile V1 schema addition**: `citations jsonb` on chat_session_messages. Per plan,
// every AI Chat response surfaces citation chips that jump back to the cited source
// (WIREFRAME 7). Citation shape: Array<{ kind: 'meeting'|'note'|'memo'|'company'|'contact',
// id: string, label: string, timestamp?: number }>.
//
// FTS5 virtual table replaced by GIN tsvector index on content (same pattern as notes).

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // contextId is opaque — could be a company_id, contact_id, meeting_id, or 'crm' for
    // the global chat. contextKind disambiguates: 'meeting' | 'company' | 'contact' |
    // 'search-results' | 'crm'.
    contextId: text('context_id').notNull(),
    contextKind: varchar('context_kind', { length: 32 }).notNull(),
    contextLabel: text('context_label'),
    title: text('title'),
    previewText: text('preview_text'),
    messageCount: integer('message_count').notNull().default(0),
    isActive: integer('is_active').notNull().default(1),
    isPinned: integer('is_pinned').notNull().default(0),
    isArchived: integer('is_archived').notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_sessions_user_idx').on(t.userId),
    // At most one active session per context.
    uniqueIndex('chat_sessions_active_idx').on(t.contextId).where(sql`${t.isActive} = 1`),
    index('chat_sessions_recent_idx').on(t.isArchived, sql`${t.lastMessageAt} DESC`),
    index('chat_sessions_context_idx').on(t.contextId, sql`${t.lastMessageAt} DESC`),
    index('chat_sessions_pinned_idx')
      .on(t.isPinned, sql`${t.lastMessageAt} DESC`)
      .where(sql`${t.isArchived} = 0`),
  ],
)

export const chatSessionMessages = pgTable(
  'chat_session_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 16 }).notNull(), // 'user' | 'assistant' | 'system'
    content: text('content').notNull(),
    // M5 addition (per plan §M5): citation chips for AI responses.
    citations: jsonb('citations'),
    // Attachments (Drive files, transcripts, etc.) — metadata only, not content.
    attachmentsJson: jsonb('attachments_json'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('chat_session_messages_session_idx').on(t.sessionId, t.createdAt),
    // GIN tsvector index on content for FTS (replaces SQLite FTS5 virtual table + triggers).
    index('chat_session_messages_fts_idx').using('gin', sql`to_tsvector('english', ${t.content})`),
  ],
)
