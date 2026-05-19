import { z } from 'zod'
import { createInsertSchema, createUpdateSchema } from 'drizzle-zod'
import { orgCompanies, orgCompanyAliases } from '../schema/companies'
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
function bundleFor(table: unknown): ValidatorBundle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any
  return {
    insert: createInsertSchema(t),
    update: createUpdateSchema(t),
    // Delete payloads are loose — gateway only reads the PK columns from
    // the decoded outbox.row_id.
    delete: z.record(z.string(), z.unknown()),
  }
}

export const WRITE_VALIDATORS: Record<string, ValidatorBundle> = {
  templates: bundleFor(templates),
  themes: bundleFor(themes),
  pipeline_configs: bundleFor(pipelineConfigs),
  speakers: bundleFor(speakers),
  pipeline_stages: bundleFor(pipelineStages),
  org_companies: bundleFor(orgCompanies),
  org_company_aliases: bundleFor(orgCompanyAliases),
  contacts: bundleFor(contacts),
  contact_emails: bundleFor(contactEmails),
  meetings: bundleFor(meetings),
  meeting_speakers: bundleFor(meetingSpeakers),
  meeting_company_links: bundleFor(meetingCompanyLinks),
  meeting_speaker_contact_links: bundleFor(meetingSpeakerContactLinks),
  notes: bundleFor(notes),
  note_folders: bundleFor(noteFolders),
  tasks: bundleFor(tasks),
  chat_sessions: bundleFor(chatSessions),
  chat_session_messages: bundleFor(chatSessionMessages),
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
