// Cyggie chat agent — contextKind-aware context builders.
//
// Extracted from api-gateway/src/routes/chat.ts in Slice 3 of the External
// Agents V1 plan. These helpers turn a chat session (or a list of
// selected company IDs) into a markdown-ish system-prompt context block.
//
// Single source of truth — the in-product chat route and the future
// MCP-side cyggie_ask wrapper both build context via this module so the
// LLM sees the same shape regardless of surface.

import type { FastifyBaseLogger } from 'fastify'
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { stripContextIdPrefix } from '@cyggie/shared'
import { getDb } from '../../db'
import { flattenSegments, truncateTranscript } from '../../llm/transcript-flatten'

// Phase 2.5: defensive cap on aggregated company-context size. Raised
// 100K → 300K to accommodate per-meeting summary + transcript content
// (notes/summary/transcript per recent meeting × 5 meetings × ~5
// companies fits in ~300K). Still well under Claude's 200K-token
// (~800K-char) input window. Per the no-cap UX decision: silently
// drops trailing companies that push past this.
const SELECTED_COMPANIES_MAX_CHARS = 300_000

// Phase 2.5: per-meeting truncation caps for the new
// composeMeetingContextBlock helper. The transcript cap is independent
// of the summary cap so one can't crowd out the other when both are
// present.
const SUMMARY_PER_MEETING_CAP = 6_000
const TRANSCRIPT_PER_MEETING_CAP = 6_000
const NOTES_PER_MEETING_CAP = 2_000

// Phase 3 — per-flagged-file cap inside a company's context block.
// Matches the desktop chat's existing 48KB per-item budget at
// packages/services/src/llm/context-builders.ts:70 (COMPANY_FILE_CAPS).
const FLAGGED_FILE_PER_FILE_CAP = 8_000

// =============================================================================
// composeMeetingContextBlock — formats one meeting for the LLM system prompt.
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ Meeting: <title> — <date>                                  │  always
//   │                                                            │
//   │ Notes:                                                     │  if notes
//   │ <truncated user-written notes>                             │
//   │                                                            │
//   │ Summary:                                                   │  if summary
//   │ <truncated AI-generated summary>                           │
//   │                                                            │
//   │ Transcript:                                                │  if transcript
//   │ <flattened + truncated transcript>                         │
//   └────────────────────────────────────────────────────────────┘
//
// Summary and transcript are BOTH included when present (no either/or
// branching): the bug fixed in Phase 2.5 was the summary missing a
// specific the user wanted to ask about — raw transcript carries those
// details. Each section has its own truncation cap.
// =============================================================================
export function composeMeetingContextBlock(args: {
  title: string | null
  date: Date
  notes: string | null
  summary: string | null
  transcriptSegmentsRaw: unknown
}): string {
  const parts: string[] = [
    `Meeting: ${args.title ?? '(untitled)'} — ${args.date.toLocaleDateString()}`,
  ]

  if (args.notes && args.notes.trim()) {
    parts.push(`Notes:\n${truncateString(args.notes, NOTES_PER_MEETING_CAP)}`)
  }
  if (args.summary && args.summary.trim()) {
    parts.push(`Summary:\n${truncateString(args.summary, SUMMARY_PER_MEETING_CAP)}`)
  }
  const transcript = flattenSegments(args.transcriptSegmentsRaw)
  if (transcript.length > 0) {
    parts.push(`Transcript:\n${truncateString(transcript, TRANSCRIPT_PER_MEETING_CAP)}`)
  }

  return parts.join('\n\n')
}

// Plain truncation helper with a visible marker — mirrors the pattern
// of truncateTranscript in transcript-flatten.ts but with a generic
// marker.
function truncateString(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}\n[...truncated...]`
}

// T17a A3 — contextKind-aware context builder. Returns a markdown-ish
// block to inject into the system prompt, or null when the session's
// contextKind has no specialized builder (crm/search-results — for
// those the conversation itself + session.contextLabel are sufficient).
//
// contextId is stored as "<kind>:<entity-id>" (see
// packages/shared/src/chat-context-id.ts). The per-entity arms strip the
// prefix via stripContextIdPrefix before looking up the underlying row.
export async function buildContextForSession(
  db: ReturnType<typeof getDb>,
  session: typeof schema.chatSessions.$inferSelect,
  log?: FastifyBaseLogger,
): Promise<string | null> {
  let result: string | null
  switch (session.contextKind) {
    case 'meeting':
      result = await buildMeetingContextForChat(
        db,
        stripContextIdPrefix('meeting', session.contextId),
        session.userId,
      )
      break
    case 'company':
      result = await buildCompanyContextForChat(
        db,
        stripContextIdPrefix('company', session.contextId),
        session.userId,
      )
      break
    case 'contact':
      result = await buildContactContextForChat(
        db,
        stripContextIdPrefix('contact', session.contextId),
        session.userId,
      )
      break
    case 'search-results':
      // contextLabel holds the search query; surface it as a brief framing
      // line so Claude knows the conversation started from a search.
      result = session.contextLabel
        ? `The user is chatting in the context of a search for: "${session.contextLabel}"`
        : null
      break
    case 'crm':
    default:
      // Phase 2 (Mobile Chat): if the user has picked companies via the
      // pill row, inject each one's context (name + industry + stage +
      // description + recent meetings) — same shape buildCompanyContextForChat
      // produces for the company-detail chat surface. Empty → null
      // (status quo); 1+ selected → aggregated context block.
      result =
        session.selectedCompanyIds && session.selectedCompanyIds.length > 0
          ? await buildSelectedCompaniesContext(
              db,
              session.selectedCompanyIds,
              session.userId,
            )
          : null
      break
  }

  // Per-entity kinds (meeting/company/contact) always expect a non-null
  // context block — null means the entity didn't resolve (malformed
  // contextId prefix, wrong userId, deleted entity). Log so this class
  // of bug is loud next time instead of silently producing ungrounded
  // answers (the May 2026 "Vital's Vault has no revenue info" report).
  if (
    result === null &&
    (session.contextKind === 'meeting' ||
      session.contextKind === 'company' ||
      session.contextKind === 'contact')
  ) {
    log?.warn(
      {
        sessionId: session.id,
        userId: session.userId,
        contextKind: session.contextKind,
        contextId: session.contextId,
      },
      'chat: per-entity session resolved to null context block',
    )
  }

  return result
}

// Phase 2: batched-query context builder for the global Ask Cyggie chat's
// selected companies. Replaces an N+1 Promise.all of
// buildCompanyContextForChat with exactly 2 SQL round-trips regardless
// of how many companies are selected:
//   Query 1: every selected company in one IN-list lookup.
//   Query 2: meetings for every selected company in one IN-list JOIN.
// Meetings are grouped client-side and trimmed to top-5-per-company.
//
// Per-company output is byte-identical to buildCompanyContextForChat
// so the LLM sees the same shape whether the user came from a company
// detail chat OR picked the company in the global chat.
//
// Combined output is truncated at SELECTED_COMPANIES_MAX_CHARS — trailing
// companies past the cap are silently dropped (no-cap UX decision).
export async function buildSelectedCompaniesContext(
  db: ReturnType<typeof getDb>,
  companyIds: string[],
  userId: string,
): Promise<string | null> {
  if (companyIds.length === 0) return null

  // Query 1: companies — same column set as buildCompanyContextForChat.
  const companies = await db
    .select({
      id: schema.orgCompanies.id,
      name: schema.orgCompanies.canonicalName,
      description: schema.orgCompanies.description,
      industry: schema.orgCompanies.industry,
      stage: schema.orgCompanies.stage,
    })
    .from(schema.orgCompanies)
    .where(
      and(
        inArray(schema.orgCompanies.id, companyIds),
        eq(schema.orgCompanies.userId, userId),
      ),
    )
  if (companies.length === 0) return null

  // Query 2: meetings for all of them in one go. We deliberately do NOT
  // use a per-company LIMIT 5 (would need a window function); fetch
  // ordered-by-date-desc and trim per company in JS.
  //
  // Phase 2.5: SELECT extended with notes/summary/transcriptSegments so
  // composeMeetingContextBlock can render the full per-meeting context
  // (was title+date only). Always-include-both decision means we always
  // need transcriptSegments — no two-pass optimization.
  const validIds = companies.map((c) => c.id)
  const allMeetings = await db
    .select({
      companyId: schema.meetingCompanyLinks.companyId,
      title: schema.meetings.title,
      date: schema.meetings.date,
      notes: schema.meetings.notes,
      summary: schema.meetings.summary,
      transcriptSegments: schema.meetings.transcriptSegments,
    })
    .from(schema.meetingCompanyLinks)
    .innerJoin(
      schema.meetings,
      eq(schema.meetingCompanyLinks.meetingId, schema.meetings.id),
    )
    .where(
      and(
        inArray(schema.meetingCompanyLinks.companyId, validIds),
        eq(schema.meetings.userId, userId),
      ),
    )
    .orderBy(desc(schema.meetings.date))

  // Bucket meetings by companyId, top-5 per (preserves desc-date order
  // since the SQL was already ORDER BY date DESC).
  const meetingsByCompany = new Map<string, typeof allMeetings>()
  for (const m of allMeetings) {
    const bucket = meetingsByCompany.get(m.companyId) ?? []
    if (bucket.length < 5) {
      bucket.push(m)
      meetingsByCompany.set(m.companyId, bucket)
    }
  }

  // Phase 3 — query 3: flagged files for these companies. Only rows
  // where the desktop extraction worker has filled in extracted_text
  // (status='done') are included; pending/extracting/failed rows are
  // silently filtered out. Single batched IN-list keeps queries O(1)
  // wrt N companies (Phase 2's batched-query invariant preserved).
  const allFiles = await db
    .select({
      companyId: schema.companyFlaggedFiles.companyId,
      fileName: schema.companyFlaggedFiles.fileName,
      extractedText: schema.companyFlaggedFiles.extractedText,
    })
    .from(schema.companyFlaggedFiles)
    .where(
      and(
        inArray(schema.companyFlaggedFiles.companyId, validIds),
        eq(schema.companyFlaggedFiles.userId, userId),
        eq(schema.companyFlaggedFiles.extractionStatus, 'done'),
        isNotNull(schema.companyFlaggedFiles.extractedText),
      ),
    )

  const filesByCompany = new Map<string, typeof allFiles>()
  for (const f of allFiles) {
    const bucket = filesByCompany.get(f.companyId) ?? []
    bucket.push(f)
    filesByCompany.set(f.companyId, bucket)
  }

  // Compose per-company blocks in input order (matches selection order).
  const byId = new Map(companies.map((c) => [c.id, c]))
  const blocks: string[] = []
  let runningSize = 0
  for (const id of companyIds) {
    const c = byId.get(id)
    if (!c) continue // stale ID, silently skip
    const parts: string[] = [`COMPANY: ${c.name}`]
    if (c.industry) parts.push(`Industry: ${c.industry}`)
    if (c.stage) parts.push(`Stage: ${c.stage}`)
    if (c.description) parts.push(`Description: ${c.description}`)
    const meetingRows = meetingsByCompany.get(c.id) ?? []
    if (meetingRows.length > 0) {
      // Phase 2.5: each meeting now renders as a full block with
      // notes/summary/transcript (whichever are present), not just
      // a title+date line.
      const meetingBlocks = meetingRows.map((m) =>
        composeMeetingContextBlock({
          title: m.title,
          date: m.date,
          notes: m.notes,
          summary: m.summary,
          transcriptSegmentsRaw: m.transcriptSegments,
        }),
      )
      parts.push(`Recent meetings:\n\n${meetingBlocks.join('\n\n')}`)
    }
    // Phase 3: flagged-file text per company. Only rows the desktop
    // worker has already extracted (status='done') reach here. Each
    // capped at FLAGGED_FILE_PER_FILE_CAP independently; combined with
    // meetings, still bounded by the 300K SELECTED_COMPANIES_MAX_CHARS
    // defensive cap below.
    const fileRows = filesByCompany.get(c.id) ?? []
    if (fileRows.length > 0) {
      const fileBlocks = fileRows
        .filter((f) => f.extractedText && f.extractedText.trim().length > 0)
        .map((f) => {
          const text = f.extractedText ?? ''
          const truncated =
            text.length > FLAGGED_FILE_PER_FILE_CAP
              ? `${text.slice(0, FLAGGED_FILE_PER_FILE_CAP)}\n[...truncated...]`
              : text
          return `### ${f.fileName}\n${truncated}`
        })
      if (fileBlocks.length > 0) {
        parts.push(`Flagged documents:\n\n${fileBlocks.join('\n\n')}`)
      }
    }
    const block = parts.join('\n')
    // Defensive total-size cap: drop trailing blocks rather than letting
    // the system prompt grow unbounded. Includes the "\n\n---\n\n"
    // separator (8 chars) in the per-block accounting.
    const blockSize = block.length + (blocks.length === 0 ? 0 : 8)
    if (runningSize + blockSize > SELECTED_COMPANIES_MAX_CHARS) break
    runningSize += blockSize
    blocks.push(block)
  }

  return blocks.length === 0 ? null : blocks.join('\n\n---\n\n')
}

async function buildMeetingContextForChat(
  db: ReturnType<typeof getDb>,
  meetingId: string,
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      title: schema.meetings.title,
      notes: schema.meetings.notes,
      transcriptSegments: schema.meetings.transcriptSegments,
    })
    .from(schema.meetings)
    .where(and(eq(schema.meetings.id, meetingId), eq(schema.meetings.userId, userId)))
    .limit(1)
  const m = rows[0]
  if (!m) return null
  return buildMeetingContext(m.title, m.notes, m.transcriptSegments as unknown)
}

// Phase 2.5: per-entity company chat delegates to the multi-company
// helper. Single-company case is just the multi-company case with one
// ID — same SELECT, same composition, same defensive cap, zero
// duplication. Side effect: the per-entity surface now inherits the
// 300K defensive cap (was unbounded). With one company × 5 meetings,
// nowhere near the cap. Mental model: "company chat = global chat
// with that company selected" is now literally true.
export async function buildCompanyContextForChat(
  db: ReturnType<typeof getDb>,
  companyId: string,
  userId: string,
): Promise<string | null> {
  return buildSelectedCompaniesContext(db, [companyId], userId)
}

export async function buildContactContextForChat(
  db: ReturnType<typeof getDb>,
  contactId: string,
  userId: string,
): Promise<string | null> {
  const contactRows = await db
    .select({
      fullName: schema.contacts.fullName,
      title: schema.contacts.title,
      email: schema.contacts.email,
      primaryCompanyId: schema.contacts.primaryCompanyId,
    })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, contactId),
        eq(schema.contacts.userId, userId),
      ),
    )
    .limit(1)
  const c = contactRows[0]
  if (!c) return null

  // Primary company name (separate lookup; could be null).
  let companyName: string | null = null
  if (c.primaryCompanyId) {
    const compRows = await db
      .select({ name: schema.orgCompanies.canonicalName })
      .from(schema.orgCompanies)
      .where(eq(schema.orgCompanies.id, c.primaryCompanyId))
      .limit(1)
    companyName = compRows[0]?.name ?? null
  }

  // Recent meetings the contact participated in (last 5, via
  // meeting_speaker_contact_links).
  //
  // Phase 2.5: SELECT extended with notes/summary/transcriptSegments so
  // the per-meeting render below can use composeMeetingContextBlock
  // (same shape as the company surfaces).
  const meetingRows = await db
    .select({
      title: schema.meetings.title,
      date: schema.meetings.date,
      notes: schema.meetings.notes,
      summary: schema.meetings.summary,
      transcriptSegments: schema.meetings.transcriptSegments,
    })
    .from(schema.meetingSpeakerContactLinks)
    .innerJoin(
      schema.meetings,
      eq(schema.meetingSpeakerContactLinks.meetingId, schema.meetings.id),
    )
    .where(
      and(
        eq(schema.meetingSpeakerContactLinks.contactId, contactId),
        eq(schema.meetings.userId, userId),
      ),
    )
    .orderBy(desc(schema.meetings.date))
    .limit(5)

  const parts: string[] = [`CONTACT: ${c.fullName}`]
  if (c.title) parts.push(`Title: ${c.title}`)
  if (companyName) parts.push(`Company: ${companyName}`)
  if (c.email) parts.push(`Email: ${c.email}`)
  if (meetingRows.length > 0) {
    // Phase 2.5: full per-meeting blocks via the shared helper (was
    // title+date-only line). Single contact, no aggregation cap needed;
    // per-meeting caps inside composeMeetingContextBlock keep output
    // bounded (5 × ~10K = ~50K worst case).
    const meetingBlocks = meetingRows.map((m) =>
      composeMeetingContextBlock({
        title: m.title,
        date: m.date,
        notes: m.notes,
        summary: m.summary,
        transcriptSegmentsRaw: m.transcriptSegments,
      }),
    )
    parts.push(`Recent meetings:\n\n${meetingBlocks.join('\n\n')}`)
  }
  return parts.join('\n')
}

function buildMeetingContext(
  title: string | null,
  notes: string | null,
  transcriptSegmentsRaw: unknown,
): string {
  const parts: string[] = []
  parts.push(`MEETING TITLE: ${title ?? '(untitled)'}`)
  if (notes && notes.trim().length > 0) {
    parts.push(`USER NOTES:\n${notes}`)
  }
  const transcript = flattenSegments(transcriptSegmentsRaw)
  if (transcript.length > 0) {
    parts.push(`TRANSCRIPT:\n${truncateTranscript(transcript)}`)
  }
  return parts.join('\n\n')
}
