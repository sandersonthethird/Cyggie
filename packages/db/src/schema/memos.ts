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
import { orgCompanies } from './companies'
import { deals } from './deals'
import { themes } from './themes'

// Investment memos. Consolidates source migrations 017 (initial), 085 (evidence),
// 090 (evidence.section + partial UNIQUE).

export const investmentMemos = pgTable(
  'investment_memos',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    themeId: text('theme_id').references(() => themes.id, { onDelete: 'set null' }),
    dealId: text('deal_id').references(() => deals.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    status: varchar('status', { length: 32 }).notNull().default('draft'),
    latestVersionNumber: integer('latest_version_number').notNull().default(0),
    createdBy: text('created_by'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('investment_memos_user_idx').on(t.userId),
    index('investment_memos_company_idx').on(t.companyId),
    index('investment_memos_status_idx').on(t.status),
  ],
)

export const investmentMemoVersions = pgTable(
  'investment_memo_versions',
  {
    id: text('id').primaryKey(),
    memoId: text('memo_id')
      .notNull()
      .references(() => investmentMemos.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    contentMarkdown: text('content_markdown').notNull(),
    structuredJson: jsonb('structured_json'),
    changeNote: text('change_note'),
    createdBy: text('created_by'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('investment_memo_versions_memo_version_idx').on(t.memoId, t.versionNumber),
    index('investment_memo_versions_memo_idx').on(t.memoId),
  ],
)

// Memo evidence — claims + sources backing each memo version. Migration 085 + 090.
// Two partial UNIQUE indexes prevent dupes:
//   - for non-web sources: unique on (version, section, claim, source_type, source_id)
//   - for web sources: unique on (version, section, claim, source_url)
export const memoEvidence = pgTable(
  'memo_evidence',
  {
    id: text('id').primaryKey(),
    versionId: text('version_id')
      .notNull()
      .references(() => investmentMemoVersions.id, { onDelete: 'cascade' }),
    section: text('section'),
    claimText: text('claim_text').notNull(),
    claimCategory: varchar('claim_category', { length: 32 }),
    sourceType: varchar('source_type', { length: 32 }).notNull(),
    sourceId: text('source_id'),
    sourceUrl: text('source_url'),
    snippet: text('snippet').notNull(),
    confidence: varchar('confidence', { length: 16 }).notNull(),
    severity: varchar('severity', { length: 16 }),
    isCritique: integer('is_critique').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memo_evidence_version_idx').on(t.versionId),
    index('memo_evidence_source_idx').on(t.sourceType, t.sourceId),
    uniqueIndex('memo_evidence_internal_idx')
      .on(t.versionId, t.section, t.claimText, t.sourceType, t.sourceId)
      .where(sql`${t.sourceType} != 'web'`),
    uniqueIndex('memo_evidence_web_idx')
      .on(t.versionId, t.section, t.claimText, t.sourceUrl)
      .where(sql`${t.sourceType} = 'web'`),
  ],
)
