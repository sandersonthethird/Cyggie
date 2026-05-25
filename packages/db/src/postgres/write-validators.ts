import { z } from 'zod'
import { createInsertSchema, createUpdateSchema } from 'drizzle-zod'
import { companyFlaggedFiles, orgCompanies, orgCompanyAliases } from '../schema/companies'
import { contacts, contactEmails } from '../schema/contacts'
import {
  meetings,
  meetingSpeakers,
  meetingCompanyLinks,
  meetingSpeakerContactLinks,
  speakers,
} from '../schema/meetings'
import { notes, noteFolders } from '../schema/notes'
import { tasks } from '../schema/tasks'
import { templates } from '../schema/templates'
import { themes } from '../schema/themes'
import { pipelineConfigs, pipelineStages } from '../schema/pipeline'
import { chatSessions, chatSessionMessages } from '../schema/chat'
import { investmentMemos, investmentMemoVersions } from '../schema/memos'

// =============================================================================
// write-validators.ts — drizzle-zod-derived zod schemas for inbound outbox
// payloads from POST /sync/push.
//
// One source of truth: when a column is added to the drizzle schema, the
// validator updates automatically — no second hand-maintained schema to
// drift. Both INSERT and UPDATE shapes are derived; UPDATE schemas are
// .partial() so any subset of columns may be present in the payload.
//
// The keys of `WRITE_VALIDATORS` match `OWNED_TABLES[*].table` in
// `../sync/owned-tables.ts`. The gateway's `/sync/push` handler looks up
// the validator by `entry.table` + `entry.op` and `.safeParse()` against
// it before upserting into Postgres.
// =============================================================================

// One bundle per owned table — separate insert/update schemas because
// drizzle-zod produces different shapes (UPDATE allows any subset, INSERT
// validates required columns are present).
interface ValidatorBundle {
  insert: z.ZodTypeAny
  update: z.ZodTypeAny
  // For deletes we don't validate the payload shape strictly — the gateway
  // only needs the PK to issue the DELETE statement. Any extras are ignored.
  delete: z.ZodTypeAny
}

// Helper: an "update" payload is any object subset of the insert schema's
// columns. drizzle-zod's createUpdateSchema already makes everything optional.
// `table` is typed loose-`any` here because drizzle's PgTable uses a Symbol
// for the table name (not a string); the helper signature would need
// drizzle's internal types to express it. The drizzle-zod functions accept
// any PgTable at runtime, so the loose typing here is a pragmatic shortcut.
//
// 2026-05-23 — drizzle-zod's stock `createInsertSchema` / `createUpdateSchema`
// emit `z.date()` for timestamp columns, which only accepts `Date` instances.
// Desktop SQLite stores timestamps as ISO strings and the outbox payload
// carries those strings unchanged. This caused every meeting/notes/etc.
// UPDATE to fail validation today with messages like
// `date: Invalid input: expected date, received string`. The preprocess
// below converts well-formed ISO strings to Date objects before validation;
// other values pass through untouched. The list of affected keys is
// table-agnostic — anything matching a date column name across the
// owned-table schemas (created_at, updated_at, last_message_at, deleted_at,
// joined_at, date) and their camelCase equivalents. False positives are
// guarded by an `isFinite(d.getTime())` check.
const DATE_KEYS = new Set([
  'date',
  'createdAt', 'created_at',
  'updatedAt', 'updated_at',
  'lastMessageAt', 'last_message_at',
  'deletedAt', 'deleted_at',
  'joinedAt', 'joined_at',
  'startsAt', 'starts_at',
  'endsAt', 'ends_at',
  'scheduledEndAt', 'scheduled_end_at',
  'lastSyncedAt', 'last_synced_at',
  // org_companies portfolio-row fields surfaced by tonight's drain.
  'dateOfInitialInvestment', 'date_of_initial_investment',
  'followonDate', 'followon_date',
])

// 2026-05-23 — desktop repo mappers (mapSession, mapMeeting, etc.) convert
// SQLite integer flags to JS booleans for renderer ergonomics. The outbox
// payload picks up the DTO shape (boolean) instead of the DB shape
// (integer), so drizzle-zod's createUpdateSchema (which sees `integer`
// columns as z.number()) rejects with "expected number, received boolean".
// Coerce true→1, false→0 for known integer-flag columns at the validator
// boundary so the existing desktop mappers don't need to change shape.
// TABLE-AWARE int-flag coerce. Same column name maps to different Postgres
// types across tables — `is_pinned` is `integer` in chat_sessions but
// `boolean` in notes, etc. A single column-name-keyed coerce can't get
// both right (the symptom: round-3 drain rejected notes.isPinned because
// the coerce flipped the JS boolean to a number that drizzle-zod then
// rejected). The fix is to look up per-table which keys need
// boolean→integer at the validator boundary.
//
// Audited 2026-05-23 — keys here MUST be Postgres `integer` columns in
// the named table that the desktop's mapper emits as JS boolean. Adding
// a key here for a Postgres `boolean` column would flip the wire format
// wrong and reject correct writes.
const INT_FLAG_KEYS_BY_TABLE: Record<string, ReadonlySet<string>> = {
  chat_sessions: new Set([
    'isActive', 'is_active',
    'isPinned', 'is_pinned',
    'isArchived', 'is_archived',
  ]),
  org_companies: new Set([
    'includeInCompaniesView', 'include_in_companies_view',
  ]),
  // notes.is_pinned → Postgres boolean (no coerce — passes through as-is)
  // meetings.is_group_event(_user_set) → Postgres boolean (no coerce)
  // chat_session_messages — no flag columns
  // Other tables — extend here if a new flag column needs coercion.
}

function makeCoerce(intFlagKeys: ReadonlySet<string>): (input: unknown) => unknown {
  return (input: unknown): unknown => {
    if (input === null || typeof input !== 'object') return input
    const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
    for (const key of Object.keys(out)) {
      const v = out[key]
      if (DATE_KEYS.has(key) && typeof v === 'string') {
        const d = new Date(v)
        if (Number.isFinite(d.getTime())) {
          out[key] = d
        }
        continue
      }
      if (intFlagKeys.has(key) && typeof v === 'boolean') {
        out[key] = v ? 1 : 0
        continue
      }
    }
    return out
  }
}

function bundleFor(table: unknown, tableName: string): ValidatorBundle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any
  const intFlagKeys = INT_FLAG_KEYS_BY_TABLE[tableName] ?? new Set<string>()
  const coerce = makeCoerce(intFlagKeys)
  return {
    insert: z.preprocess(coerce, createInsertSchema(t)),
    update: z.preprocess(coerce, createUpdateSchema(t)),
    // Delete payloads are loose — gateway only reads the PK columns from
    // the decoded outbox.row_id.
    delete: z.record(z.string(), z.unknown()),
  }
}

export const WRITE_VALIDATORS: Record<string, ValidatorBundle> = {
  templates: bundleFor(templates, 'templates'),
  themes: bundleFor(themes, 'themes'),
  pipeline_configs: bundleFor(pipelineConfigs, 'pipeline_configs'),
  speakers: bundleFor(speakers, 'speakers'),
  pipeline_stages: bundleFor(pipelineStages, 'pipeline_stages'),
  org_companies: bundleFor(orgCompanies, 'org_companies'),
  // Phase 3 — flagged-file extraction. drizzle-zod derives both insert
  // and update validators from the Postgres schema, so the new columns
  // (extracted_text, drive_version, flagged_by_user_id, extraction_*,
  // extracted_at, lamport) auto-validate without further wiring.
  company_flagged_files: bundleFor(companyFlaggedFiles, 'company_flagged_files'),
  org_company_aliases: bundleFor(orgCompanyAliases, 'org_company_aliases'),
  contacts: bundleFor(contacts, 'contacts'),
  contact_emails: bundleFor(contactEmails, 'contact_emails'),
  meetings: bundleFor(meetings, 'meetings'),
  meeting_speakers: bundleFor(meetingSpeakers, 'meeting_speakers'),
  meeting_company_links: bundleFor(meetingCompanyLinks, 'meeting_company_links'),
  meeting_speaker_contact_links: bundleFor(meetingSpeakerContactLinks, 'meeting_speaker_contact_links'),
  notes: bundleFor(notes, 'notes'),
  note_folders: bundleFor(noteFolders, 'note_folders'),
  tasks: bundleFor(tasks, 'tasks'),
  chat_sessions: bundleFor(chatSessions, 'chat_sessions'),
  chat_session_messages: bundleFor(chatSessionMessages, 'chat_session_messages'),
  investment_memos: bundleFor(investmentMemos, 'investment_memos'),
  investment_memo_versions: bundleFor(investmentMemoVersions, 'investment_memo_versions'),
}

export type WriteOp = 'insert' | 'update' | 'delete'

/**
 * Validate one outbox payload against the canonical shape for its table.
 * Returns `{ ok: true, data }` on success or `{ ok: false, reason }` on
 * failure (with a zod-formatted error string suitable for outbox.last_error).
 */
export function validateWritePayload(
  table: string,
  op: WriteOp,
  payload: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; reason: string } {
  const bundle = WRITE_VALIDATORS[table]
  if (!bundle) {
    return { ok: false, reason: `Unknown table '${table}'` }
  }
  const schema = bundle[op]
  const result = schema.safeParse(payload)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .slice(0, 5)
      .join('; ')
    return { ok: false, reason: `validation: ${issues}` }
  }
  return { ok: true, data: result.data as Record<string, unknown> }
}
