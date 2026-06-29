/**
 * Multi-entity chat: chatDispatch({kind:'entities'}) lands here.
 *
 * The user can attach the full context of several companies/contacts to one
 * chat (the "+ Add context" chips). This builder folds them all into a single
 * prompt while DEDUPING shared items — a company and one of its own contacts
 * overlap heavily (the same meetings, email threads, notes), and sending each
 * twice wastes tokens and lets duplicates push unique content past the cap.
 *
 *   refs.length
 *   ┌──────────┬──────────────────────────────────────────────────────────┐
 *   │   0      │ delegate to queryAll (global) — defensive; renderer routes │
 *   │          │ 0 entities straight to CHAT_QUERY_ALL                       │
 *   │   1      │ delegate to queryCompany / queryContact — byte-identical    │
 *   │          │ to the single-entity path (parity snapshots, empty-state)   │
 *   │  ≥2      │ buildUnifiedEntitiesContext: gather each entity's items in  │
 *   │          │ parallel → dedupe by id → render single ## sections under   │
 *   │          │ per-entity header blocks → runChatTurn                       │
 *   └──────────┴──────────────────────────────────────────────────────────┘
 *
 * Dedup keys: meetings by meeting id, emails by thread (renderEmailRows
 * groups by threadGroup and skips repeats via its `seen` set), notes by note
 * id, flagged files by fileId. A defensive OUTER_TOTAL_CAP guards the whole
 * assembled context with a console.warn on drop (no silent truncation).
 */

import * as companyRepo from '@cyggie/db/sqlite/repositories/org-company.repo'
import * as contactRepo from '@cyggie/db/sqlite/repositories/contact.repo'
import * as meetingRepo from '@cyggie/db/sqlite/repositories/meeting.repo'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'
import { getFlaggedFilesDetailed } from '@cyggie/db/sqlite/repositories/company-file-flags.repo'
import { getPreference } from '@cyggie/db/sqlite/repositories/user-preferences.repo'
import {
  formatMeetingsSection,
  formatNotesSection,
  formatFlaggedFilesSection,
  type SectionCaps,
  type MeetingRef,
  type NoteRef,
  type FlaggedFileRef,
} from './context-formatters'
import {
  renderEmailRows,
  resolveEmailCap,
  emailCapsForLimit,
  COMPANY_EMAIL_CAPS,
  EMAIL_THREADS_PREF_KEY,
} from './email-signal'
import { runChatTurn, abortChatTurn } from './chat-runner'
import { queryCompany } from './company-chat'
import { queryContact } from './contact-chat'
import { queryAll } from './crm-chat'
import type { ChatAttachment } from '@shared/types/chat'
import type { ChatEmailMessage } from '@shared/types/company'

export interface EntityRef {
  type: 'company' | 'contact'
  id: string
}

// Multi-entity caps: union budgets, sized between the single-company and
// global ceilings. Per-item caps match the single-entity assemblers so an
// individual meeting/file looks the same whether viewed alone or in a set.
const MULTI_SUMMARY_CAPS: SectionCaps = { perItem: 8_000, total: 40_000 }
const MULTI_TRANSCRIPT_CAPS: SectionCaps = { perItem: 3_000, total: Number.MAX_SAFE_INTEGER }
const MULTI_NOTE_CAPS: SectionCaps = { perItem: 2_000, total: 12_000 }
const MULTI_FILE_CAPS: SectionCaps = { perItem: 48_000, total: 300_000 }
// Hard ceiling on the whole assembled context (defensive; warns on drop).
const OUTER_TOTAL_CAP = 600_000

export const ENTITIES_SYSTEM_PROMPT = `You are a helpful research assistant for a venture capital firm.
You answer questions using the combined context of several companies and people
the user has attached: meeting notes and transcripts, email correspondence,
linked documents, and notes. The context is deduplicated — each meeting, email
thread, note, and file appears once even when it relates to more than one of the
attached entities.
Answer accurately based on the provided context. If information isn't available,
say so. Be concise but thorough. Use bullet points when listing multiple items.`

export function abortEntitiesChat(): void {
  abortChatTurn()
}

interface EntityItems {
  ref: EntityRef
  /** Display name; null when the entity no longer resolves (deleted). */
  name: string | null
  headerBlock: string | null
  meetings: MeetingRef[]
  emailRows: ChatEmailMessage[]
  notes: NoteRef[]
  files: FlaggedFileRef[]
}

const _companyNotesRepo = makeEntityNotesRepo('company_id')
const _contactNotesRepo = makeEntityNotesRepo('contact_id')

/** Gather one entity's raw items. Returns name=null (and empty items) when
 *  the entity no longer resolves — the caller surfaces "unavailable" and the
 *  renderer greys the chip. Never throws on a missing entity. */
function gatherEntityItems(ref: EntityRef, emailCap: number): EntityItems {
  if (ref.type === 'company') {
    const company = companyRepo.getCompany(ref.id)
    if (!company) {
      return { ref, name: null, headerBlock: null, meetings: [], emailRows: [], notes: [], files: [] }
    }
    const meta: string[] = []
    if (company.stage) meta.push(`Stage: ${company.stage}`)
    if (company.round) meta.push(`Round: ${company.round}`)
    if (company.industry) meta.push(`Industry: ${company.industry}`)
    const headerParts = [`# Company: ${company.canonicalName}`]
    if (company.description) headerParts.push(company.description)
    if (meta.length) headerParts.push(meta.join(' | '))
    return {
      ref,
      name: company.canonicalName,
      headerBlock: headerParts.join('\n'),
      meetings: companyRepo.listCompanyMeetings(ref.id).map((m) => ({ id: m.id, title: m.title, date: m.date })),
      emailRows: companyRepo.listCompanyEmailMessagesForChat(ref.id, emailCap),
      notes: _companyNotesRepo.list(ref.id),
      files: getFlaggedFilesDetailed(ref.id),
    }
  }
  const contact = contactRepo.getContact(ref.id)
  if (!contact) {
    return { ref, name: null, headerBlock: null, meetings: [], emailRows: [], notes: [], files: [] }
  }
  const meta: string[] = []
  if (contact.title) meta.push(`Title: ${contact.title}`)
  if (contact.primaryCompany) meta.push(`Company: ${contact.primaryCompany.canonicalName}`)
  if (contact.contactType) meta.push(`Type: ${contact.contactType}`)
  const headerParts = [`# Contact: ${contact.fullName}`]
  if (meta.length) headerParts.push(meta.join(' | '))
  return {
    ref,
    name: contact.fullName,
    headerBlock: headerParts.join('\n'),
    meetings: (contact.meetings ?? []).map((m) => ({ id: m.id, title: m.title, date: m.date })),
    emailRows: contactRepo.listContactEmailMessagesForChat(ref.id, emailCap),
    notes: _contactNotesRepo.list(ref.id),
    files: [],
  }
}

/**
 * Build the deduped multi-entity context markdown for N≥2 attached entities.
 * Returns null when no attached entity yields any content (so the caller can
 * emit the curated empty-state response instead of a degraded LLM call).
 */
export async function buildUnifiedEntitiesContext(
  refs: EntityRef[],
  opts: { excludeMeetingId?: string } = {},
): Promise<{
  markdown: string | null
  resolvedNames: string[]
  unavailable: EntityRef[]
}> {
  const emailCap = resolveEmailCap(getPreference(EMAIL_THREADS_PREF_KEY))

  // Phase 1: gather every entity's items concurrently (each call does its own
  // SQLite reads). Promise.all preserves `refs` order → stable output → the
  // prompt cache hits on later turns when the attached set is unchanged.
  const gathered = await Promise.all(refs.map((ref) => Promise.resolve(gatherEntityItems(ref, emailCap))))

  const resolved = gathered.filter((g) => g.name !== null)
  const unavailable = gathered.filter((g) => g.name === null).map((g) => g.ref)

  // Phase 2: merge + dedupe by id. First-in-stored-order wins.
  const meetingById = new Map<string, MeetingRef>()
  const noteById = new Map<string, NoteRef>()
  const fileById = new Map<string, FlaggedFileRef>()
  const emailRows: ChatEmailMessage[] = []
  const headerBlocks: string[] = []

  for (const g of resolved) {
    if (g.headerBlock) headerBlocks.push(g.headerBlock)
    for (const m of g.meetings) {
      // Skip a caller-excluded meeting (e.g. the meeting a meeting-chat is
      // anchored on — its full transcript is already in context, so we must not
      // re-add a 3k-truncated copy here).
      if (opts.excludeMeetingId && m.id === opts.excludeMeetingId) continue
      if (!meetingById.has(m.id)) meetingById.set(m.id, m)
    }
    for (const n of g.notes) {
      const id = (n as NoteRef & { id?: string }).id
      // Notes without a stable id (shouldn't happen for persisted rows) fall
      // back to a content hash so identical notes still dedupe.
      const key = id ?? `${n.title ?? ''}::${n.content.slice(0, 64)}`
      if (!noteById.has(key)) noteById.set(key, n)
    }
    for (const f of g.files) if (!fileById.has(f.fileId)) fileById.set(f.fileId, f)
    // Email rows are merged raw; renderEmailRows groups by thread and dedupes
    // shared threads via its internal grouping (a thread shared by company +
    // contact lands in one bucket).
    emailRows.push(...g.emailRows)
  }

  // Phase 3: render each section once over the deduped item sets.
  const meetingsMd = formatMeetingsSection({
    meetings: [...meetingById.values()],
    loadFull: (id) => {
      const full = meetingRepo.getMeeting(id)
      if (!full) return null
      return { id: full.id, summaryPath: full.summaryPath, transcriptPath: full.transcriptPath, isPrivate: full.isPrivate }
    },
    summaryCaps: MULTI_SUMMARY_CAPS,
    transcriptCaps: MULTI_TRANSCRIPT_CAPS,
  })
  const emailsMd = renderEmailRows(emailRows, emailCapsForLimit(COMPANY_EMAIL_CAPS, emailCap))
  const notesMd = formatNotesSection([...noteById.values()], MULTI_NOTE_CAPS)
  const filesMd = await formatFlaggedFilesSection([...fileById.values()], MULTI_FILE_CAPS)

  const hasAnyData = Boolean(meetingsMd || emailsMd || notesMd || filesMd)
  if (!hasAnyData && headerBlocks.length === 0) {
    return { markdown: null, resolvedNames: [], unavailable }
  }

  const sections = [headerBlocks.join('\n\n'), meetingsMd, emailsMd, notesMd, filesMd].filter(Boolean)
  let markdown = sections.join('\n\n')
  if (markdown.length > OUTER_TOTAL_CAP) {
    console.warn(
      `[entities-chat] combined context ${markdown.length} chars exceeds cap ${OUTER_TOTAL_CAP}; truncating`,
    )
    markdown = markdown.slice(0, OUTER_TOTAL_CAP) + '\n\n…[context truncated to fit budget]'
  }

  return {
    markdown: hasAnyData ? markdown : null,
    resolvedNames: resolved.map((g) => g.name as string),
    unavailable,
  }
}

/**
 * Entry point for chatDispatch({kind:'entities'}). Routes by attached-entity
 * count (see file header). Returns the assistant text.
 */
export async function queryEntities(
  refs: EntityRef[],
  question: string,
  attachments?: ChatAttachment[],
): Promise<string> {
  const valid = (refs ?? []).filter(
    (r): r is EntityRef => !!r && (r.type === 'company' || r.type === 'contact') && !!r.id,
  )

  // 0 entities: defensive only — the renderer routes the empty set to
  // CHAT_QUERY_ALL. Delegate to the global chat so behavior is sane if reached.
  if (valid.length === 0) {
    return queryAll(question, attachments ?? [])
  }

  // 1 entity: delegate to the single-entity path verbatim (parity-identical
  // prompt, curated empty-state reused).
  if (valid.length === 1) {
    const only = valid[0]
    return only.type === 'company'
      ? queryCompany(only.id, question, attachments)
      : queryContact(only.id, question, attachments)
  }

  // ≥2 entities: deduped union.
  const { markdown, resolvedNames } = await buildUnifiedEntitiesContext(valid)

  if (!markdown) {
    // Entities exist but have no data yet (or all deleted) — curated message,
    // no wasted LLM turn. Mirrors the single-entity empty-state policy.
    const names = resolvedNames.length > 0 ? resolvedNames.join(', ') : 'the attached items'
    return `I have very little information about ${names} yet. Try linking some meetings, syncing emails, adding notes, or flagging files first.`
  }

  return runChatTurn({
    systemPrompt: ENTITIES_SYSTEM_PROMPT,
    context: markdown,
    question,
    attachments,
    userPromptPrefix: 'Here is the available information about the attached companies and contacts:',
    questionLabel: 'Question',
  })
}
