import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core'
import { users } from './auth'
import { orgCompanies } from './companies'
import { contacts } from './contacts'
import { templates } from './templates'

// =============================================================================
// MEETINGS — central domain. Consolidates source migrations:
//   001 (initial), 003 (notes), 004 (transcript_segments), 005 (drive cols),
//   006 (attendees), 011 (recording_path), 025 (auth-foundation user FKs),
//   042 (notes_source linkage from notes side), 055 (speaker_contact_links),
//   064 (calendar_event_dedup unique partial index), 071 (dismissed_companies),
//   089 (transcript_summaries cache).
//
// Type translations applied:
//   • TEXT ISO timestamps  → timestamp with time zone
//   • TEXT JSON columns    → jsonb
//   • TEXT speaker_map     → jsonb (Record<int, string>)
//   • BOOLEAN 0/1          → real boolean
//   • Trigger CHECKs       → Postgres CHECK constraints (cleaner than SQLite triggers)
//
// Multi-tenant scaffolding: user_id FK (canonical owner). The pre-existing
// created_by_user_id / updated_by_user_id columns (from migration 025) become audit
// fields — user_id is the tenancy root for RLS.
//
// Sync metadata: every owned row has _lamport (text, default '0'); writeWithSync
// helper at the repo layer bumps it + appends to outbox in one transaction.
//
// Mobile additions (Phase 0.2 baseline):
//   • was_impromptu — true when the meeting was created on-the-fly by the mobile
//     Record FAB outside any calendar slot (per wireframe annotation in plan).
// =============================================================================

export const meetings = pgTable(
  'meetings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // SQLite stored as ISO TEXT; Postgres uses timestamptz. The data migration
    // script (Phase 0.3) parses the ISO strings on read.
    date: timestamp('date', { withTimezone: true }).notNull(),
    // Scheduled end time from the originating calendar event (migration 0015).
    // Only set on rows created from POST /meetings/from-calendar-event; null
    // for impromptu / Record-FAB-originated rows. Detail screen renders
    // "X min scheduled" pre-recording from (scheduledEndAt - date). Once
    // status flips to 'transcribed' the actual durationSeconds takes over.
    scheduledEndAt: timestamp('scheduled_end_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    calendarEventId: text('calendar_event_id'),
    meetingPlatform: varchar('meeting_platform', { length: 32 }),
    meetingUrl: text('meeting_url'),
    // Storage paths (desktop: local disk; gateway: R2 keys).
    transcriptPath: text('transcript_path'),
    summaryPath: text('summary_path'),
    recordingPath: text('recording_path'),
    // Google Drive integration (migration 005).
    transcriptDriveId: text('transcript_drive_id'),
    summaryDriveId: text('summary_drive_id'),
    // Template reference (initial templates table FK).
    templateId: text('template_id').references(() => templates.id),
    // Speaker bookkeeping. speakerMap is { [speakerIndex]: name } populated as users
    // tag speakers. speakerCount is the raw diarization count from Deepgram.
    speakerCount: integer('speaker_count').notNull().default(0),
    speakerMap: jsonb('speaker_map').notNull().default({}),
    // Transcript segments (Deepgram word-level output). Lives both in the database
    // (for fast access without file I/O) AND on disk at transcript_path (canonical).
    // Migration 004 added the column; payload shape lives in @cyggie/shared/types/recording.ts.
    transcriptSegments: jsonb('transcript_segments'),
    // Free-form notes captured during the meeting. Auto-populated post-finalize by the
    // mobile flow per WIREFRAME 6 (Meeting Notes editor with Enhance button).
    notes: text('notes'),
    // AI-generated meeting summary (markdown). Dual-written by the desktop summarizer
    // alongside the existing summary_path file so mobile can read the content via
    // GET /meetings/:id without needing access to the desktop's local filesystem.
    // Nullable: pre-migration meetings and meetings that haven't been summarized yet
    // surface as null on mobile ("No summary yet" empty state).
    summary: text('summary'),
    // Calendar attendees. attendees = display names/emails; attendeeEmails = parsed emails.
    // attendees EXCLUDES the meeting owner (filtered out via Google Calendar's `self` flag at
    // fetch time in google-calendar.ts:19). The owner's calendar-side display name is stored
    // separately in self_name so the enhance handler can prepend it without doing a users
    // table lookup — and so the "self" identity travels with the meeting row, not the
    // requesting user. The latter matters once firm-shared meetings ship (T24 area): a
    // user enhancing a colleague's meeting should NOT have their own name spliced in.
    attendees: jsonb('attendees'),
    attendeeEmails: jsonb('attendee_emails'),
    selfName: text('self_name'),
    // Legacy: pre-migration 078 chat history. Kept for backward compat; new chat lives in
    // chat_sessions / chat_session_messages. Marked deprecated — do not write from new code.
    chatMessages: jsonb('chat_messages'),
    // Legacy: denormalized list of linked company IDs. Source of truth is meeting_company_links.
    // Kept for the desktop's listMeetings hot path (avoids a join). New code should join through
    // meeting_company_links.
    companies: jsonb('companies'),
    // Companies the user dismissed as suggestions (migration 071) — keep these from being
    // re-suggested by the AI.
    dismissedCompanies: jsonb('dismissed_companies'),
    status: varchar('status', { length: 32 }).notNull().default('recording'),
    // M3 — set when the gateway submits an uploaded audio file to Deepgram's
    // batch API. Used by the on-boot reconciler to poll Deepgram for jobs that
    // were in-flight when the gateway restarted, so we don't drop the
    // transcript on the floor. Nullable for desktop-originated meetings that
    // bypass the gateway transcribe path entirely.
    deepgramRequestId: text('deepgram_request_id'),
    // Mobile: true when this meeting was created via the global Record FAB outside any
    // calendar slot. Summary screen prompts for a real title + linked company.
    wasImpromptu: boolean('was_impromptu').notNull().default(false),
    // Group-event ingestion gate (migration 098). When true, syncContactsFromAttendees
    // and meeting_company_links auto-population are skipped for this meeting — the
    // attendee list is preserved on the row but no CRM contacts/companies are seeded.
    // isGroupEventUserSet locks the auto-flag against calendar re-sync recomputes.
    isGroupEvent: boolean('is_group_event').notNull().default(false),
    isGroupEventUserSet: boolean('is_group_event_user_set').notNull().default(false),
    // Audit fields (migration 025 auth-foundation).
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Sync metadata.
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('meetings_user_idx').on(t.userId),
    index('meetings_date_idx').on(t.date),
    index('meetings_status_idx').on(t.status),
    index('meetings_created_by_idx').on(t.createdByUserId),
    index('meetings_updated_by_idx').on(t.updatedByUserId),
    // Calendar event dedup — UNIQUE per-user (migration 0014 — was global-
    // unique in 064; the global constraint blocked multi-tenant operation
    // because two users invited to the same Google calendar event share
    // the event id and couldn't both have a row). One meeting per
    // (user_id, calendar_event_id) pair, where calendar_event_id is set.
    uniqueIndex('meetings_user_calendar_event_idx')
      .on(t.userId, t.calendarEventId)
      .where(sql`${t.calendarEventId} IS NOT NULL`),
  ],
)

// Canonical speaker store (migration 001). Speakers are app-level identities (often
// linked to a Contact via meeting_speaker_contact_links). Names here are display-only;
// real-person mapping lives in the link table.
export const speakers = pgTable('speakers', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  notes: text('notes'),
  lamport: text('lamport').notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Per-meeting speaker labels (migration 001). One row per (meeting, speaker_index).
// label is what the user sees ("Priya", "Speaker 1"); speaker_id points to the canonical
// speakers row when known.
export const meetingSpeakers = pgTable(
  'meeting_speakers',
  {
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    speakerIndex: integer('speaker_index').notNull(),
    speakerId: text('speaker_id').references(() => speakers.id, { onDelete: 'set null' }),
    label: text('label').notNull().default('Speaker'),
    lamport: text('lamport').notNull().default('0'),
  },
  (t) => [primaryKey({ columns: [t.meetingId, t.speakerIndex] })],
)

// Speaker → Contact mapping (migration 055). Once the user tags "Speaker 2 is Priya
// at Init Labs", this row links the diarized speaker to a Contact row. Powers the
// "who said what" cross-reference in the UI.
export const meetingSpeakerContactLinks = pgTable(
  'meeting_speaker_contact_links',
  {
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    speakerIndex: integer('speaker_index').notNull(),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.speakerIndex] }),
    index('speaker_contact_links_contact_idx').on(t.contactId),
  ],
)

// Meeting ↔ Company join table. confidence is the AI's confidence in the link; linked_by
// is 'auto' (AI-detected) or 'manual' (user). CHECK constraints replace the SQLite triggers
// that enforced 0 ≤ confidence ≤ 1.
export const meetingCompanyLinks = pgTable(
  'meeting_company_links',
  {
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => orgCompanies.id, { onDelete: 'cascade' }),
    confidence: doublePrecision('confidence').notNull().default(1.0),
    linkedBy: varchar('linked_by', { length: 32 }).notNull().default('auto'),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    updatedByUserId: text('updated_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    lamport: text('lamport').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.companyId] }),
    index('meeting_company_links_company_idx').on(t.companyId),
    index('meeting_company_links_created_by_idx').on(t.createdByUserId),
    index('meeting_company_links_updated_by_idx').on(t.updatedByUserId),
    check('meeting_company_links_confidence_range', sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
  ],
)

// Haiku-generated transcript summaries cache (migration 089). Used by the memo producer
// agent's context budget manager — when total transcript volume exceeds the recent-
// transcripts budget, oldest raw transcripts get displaced to cheap Haiku summaries.
//
// Keyed by (transcript_path, content_hash) so edits to a transcript invalidate the cache.
// Not user-scoped — this is a server-side cache, not user content.
export const transcriptSummaries = pgTable(
  'transcript_summaries',
  {
    transcriptPath: text('transcript_path').notNull(),
    contentHash: text('content_hash').notNull(),
    summary: text('summary').notNull(),
    tokenCount: integer('token_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.transcriptPath, t.contentHash] })],
)
