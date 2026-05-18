/**
 * Context builders — one assemble/build pair per ChatKind.
 *
 *   ┌────────────────────────┐
 *   │ assembleEntityContext  │  pure data assembly. Returns
 *   │                        │  { markdown, hasMeetings, hasEmails, ... }.
 *   │                        │  Used by chatDispatch AND by other
 *   │                        │  consumers (e.g. contact-key-takeaways).
 *   └────────────┬───────────┘
 *                │
 *                ▼ wraps as BuilderResult
 *   ┌────────────────────────┐
 *   │ buildEntityContext     │  the chatDispatch entry. Returns the
 *   │                        │  discriminated union. Empty signals →
 *   │                        │  { kind: 'response', text: '...' }
 *   │                        │  to short-circuit the LLM call.
 *   └────────────────────────┘
 *
 * Per /plan-eng-review Issue 1D: each entity has TWO functions, each with
 * one return shape and one job. No dual-API.
 */

import { formatMeetingsSection, formatEmailsSection, formatNotesSection, formatFlaggedFilesSection, type SectionCaps } from './context-formatters'
import { readSummary, readTranscript } from '@main/storage/file-manager'
import * as companyRepo from '@cyggie/db/sqlite/repositories/org-company.repo'
import * as contactRepo from '@cyggie/db/sqlite/repositories/contact.repo'
import * as meetingRepo from '@cyggie/db/sqlite/repositories/meeting.repo'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'
import { getFlaggedFiles } from '@cyggie/db/sqlite/repositories/company-file-flags.repo'

const _contactNotesRepo = makeEntityNotesRepo('contact_id')
const _companyNotesRepo = makeEntityNotesRepo('company_id')

// ── BuilderResult — the chatDispatch contract ─────────────────────────

export type BuilderResult =
  /** Happy path: assembled context for the LLM. */
  | { kind: 'context'; markdown: string }
  /** Empty-state with curated message — chatDispatch returns text directly,
   *  no LLM call. Preserves today's queryAll-style canned responses. */
  | { kind: 'response'; text: string }
  /** Fatal — chatDispatch throws; renderer surfaces via parseChatError.
   *  Preserves today's queryMeeting "No transcript available" throw. */
  | { kind: 'error'; message: string }

// ── Company ──────────────────────────────────────────────────────────────

/** Signals + assembled markdown for a company. Returned by
 *  `assembleCompanyContext` so consumers can decide their own empty-state
 *  behavior (chatDispatch wraps as BuilderResult; other future consumers may
 *  want raw signals). */
export interface CompanyContextSignals {
  markdown: string
  hasMeetings: boolean
  hasEmails: boolean
  hasNotes: boolean
  hasFlaggedFiles: boolean
}

// Caps preserved verbatim from the legacy queryCompany code in
// company-chat.ts:25-31. Keep these per-kind — different surfaces budget
// emails / files differently.
const COMPANY_SUMMARY_CAPS: SectionCaps = { perItem: 8_000, total: 30_000 }
const COMPANY_TRANSCRIPT_CAPS: SectionCaps = { perItem: 3_000, total: Number.MAX_SAFE_INTEGER }
const COMPANY_EMAIL_CAPS: SectionCaps = { perItem: 2_000, total: 15_000, maxItems: 20 }
const COMPANY_NOTE_CAPS: SectionCaps = { perItem: 2_000, total: 8_000 }
// Bumped from 6_000 / 30_000. Pitch decks etc. now fit substantially in chat
// context per turn. ChatContextSizeBanner shows the running estimate so the
// user sees what they're about to send to the LLM.
const COMPANY_FILE_CAPS: SectionCaps = { perItem: 48_000, total: 300_000 }

/**
 * Assemble company context from repos. Returns markdown + flags so
 * `buildCompanyContext` (and any future consumer) can apply its own
 * empty-state policy.
 *
 * Wire format matches the pre-refactor queryCompany verbatim:
 *
 *   # Company: <name>
 *   <description>
 *   Stage: ... | Round: ... | Industry: ...
 *
 *   ## Meeting Summaries
 *   ### Title (date)
 *   <summary>
 *
 *   ## Meeting Transcripts
 *   ### Title (date)
 *   <transcript>
 *
 *   ## Email Correspondence
 *   From: ... / Subject: ... / Date: ... / <body>
 *
 *   ## Linked Documents
 *   ### filename
 *   <content>
 *
 * (with a trailing newline matching today's `parts.push('')` + `parts.join('\n')`).
 */
export async function assembleCompanyContext(companyId: string): Promise<CompanyContextSignals> {
  const company = companyRepo.getCompany(companyId)
  if (!company) throw new Error('Company not found')

  const parts: string[] = []

  // Header
  parts.push(`# Company: ${company.canonicalName}`)
  if (company.description) parts.push(company.description)
  const meta: string[] = []
  if (company.stage) meta.push(`Stage: ${company.stage}`)
  if (company.round) meta.push(`Round: ${company.round}`)
  if (company.industry) meta.push(`Industry: ${company.industry}`)
  if (meta.length) parts.push(meta.join(' | '))
  parts.push('')

  // Meetings (summaries with transcript fallback)
  const meetingRefs = companyRepo.listCompanyMeetings(companyId).map((m) => ({
    id: m.id,
    title: m.title,
    date: m.date,
  }))
  const meetingsMd = formatMeetingsSection({
    meetings: meetingRefs,
    loadFull: (id) => {
      const full = meetingRepo.getMeeting(id)
      if (!full) return null
      return { id: full.id, summaryPath: full.summaryPath, transcriptPath: full.transcriptPath }
    },
    summaryCaps: COMPANY_SUMMARY_CAPS,
    transcriptCaps: COMPANY_TRANSCRIPT_CAPS,
  })
  const hasMeetings = meetingsMd.length > 0
  if (hasMeetings) {
    parts.push(meetingsMd)
    parts.push('')
  }

  // Emails
  const emails = companyRepo.listCompanyEmails(companyId)
  const emailsMd = formatEmailsSection(emails, COMPANY_EMAIL_CAPS)
  const hasEmails = emailsMd.length > 0
  if (hasEmails) {
    parts.push(emailsMd)
    parts.push('')
  }

  // Notes (added in Step 10 — bonus gap from the original /plan-eng-review).
  // Contact chat already pulls notes via assembleContactContext; companies
  // were previously omitted. Same formatNotesSection helper.
  const notes = _companyNotesRepo.list(companyId)
  const notesMd = formatNotesSection(notes, COMPANY_NOTE_CAPS)
  const hasNotes = notesMd.length > 0
  if (hasNotes) {
    parts.push(notesMd)
    parts.push('')
  }

  // Flagged files (mime-aware: dispatches to local readers OR Drive export
  // depending on the stored mimeType; legacy rows with NULL mimeType take
  // the local-file path via extension detection inside readLocalFile).
  const flaggedFiles = getFlaggedFiles(companyId)
  const filesMd = await formatFlaggedFilesSection(flaggedFiles, COMPANY_FILE_CAPS)
  const hasFlaggedFiles = filesMd.length > 0
  if (hasFlaggedFiles) {
    parts.push(filesMd)
    parts.push('')
  }

  return {
    markdown: parts.join('\n'),
    hasMeetings,
    hasEmails,
    hasNotes,
    hasFlaggedFiles,
  }
}

/** chatDispatch entry for company chats. Wraps `assembleCompanyContext`
 *  with the empty-state policy: if a company has zero meetings, zero emails,
 *  AND zero flagged files, short-circuit with a curated response. */
export async function buildCompanyContext(opts: { companyId: string }): Promise<BuilderResult> {
  let signals: CompanyContextSignals
  try {
    signals = await assembleCompanyContext(opts.companyId)
  } catch (err) {
    if (err instanceof Error && err.message === 'Company not found') {
      return { kind: 'error', message: 'Company not found' }
    }
    throw err
  }

  if (!signals.hasMeetings && !signals.hasEmails && !signals.hasNotes && !signals.hasFlaggedFiles) {
    // Company exists but has no signal yet — degraded LLM call today; from
    // here on, a curated message that won't waste a turn.
    const company = companyRepo.getCompany(opts.companyId)
    const name = company?.canonicalName ?? 'this company'
    return {
      kind: 'response',
      text: `I have very little information about ${name} yet. Try linking some meetings, emails, or notes first, or flag a file in the Files tab to add it as context.`,
    }
  }

  return { kind: 'context', markdown: signals.markdown }
}

/** Per-kind system prompt. Paired with the builder so chatDispatch can
 *  invoke {builder, prompt} together. */
export const COMPANY_SYSTEM_PROMPT = `You are a helpful research assistant for a venture capital firm.
You answer questions about a specific portfolio company using all available context:
meeting notes and transcripts, email correspondence, and linked documents.
Answer accurately based on the provided context. If information isn't available, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

// ── Contact ──────────────────────────────────────────────────────────────

export interface ContactContextSignals {
  markdown: string
  hasMeetings: boolean
  hasEmails: boolean
  hasNotes: boolean
}

// Caps preserved verbatim from contact-context-builder.ts:8-14.
const CONTACT_SUMMARY_CAPS: SectionCaps = { perItem: 6_000, total: 24_000 }
const CONTACT_TRANSCRIPT_CAPS: SectionCaps = { perItem: 2_500, total: Number.MAX_SAFE_INTEGER }
const CONTACT_EMAIL_CAPS: SectionCaps = { perItem: 1_500, total: 12_000, maxItems: 20 }
const CONTACT_NOTE_CAPS: SectionCaps = { perItem: 2_000, total: 8_000 }

/**
 * Assemble contact context from repos. Returns markdown + signals so both
 * `buildContactContext` (chatDispatch) and `contact-key-takeaways` can apply
 * their own empty-state policies (Issue 1D — one shared assembler, two
 * thin wrappers).
 *
 * Wire format matches the pre-refactor buildContactContext verbatim.
 */
export function assembleContactContext(contactId: string): ContactContextSignals {
  const contact = contactRepo.getContact(contactId)
  if (!contact) throw new Error('Contact not found')

  const parts: string[] = []

  // Header
  parts.push(`# Contact: ${contact.fullName}`)
  const meta: string[] = []
  if (contact.title) meta.push(`Title: ${contact.title}`)
  if (contact.primaryCompany) meta.push(`Company: ${contact.primaryCompany.canonicalName}`)
  if (contact.contactType) meta.push(`Type: ${contact.contactType}`)
  if (meta.length) parts.push(meta.join(' | '))
  parts.push('')

  // Meetings (summaries with transcript fallback)
  const meetingRefs = (contact.meetings ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    date: m.date,
  }))
  const meetingsMd = formatMeetingsSection({
    meetings: meetingRefs,
    loadFull: (id) => {
      const full = meetingRepo.getMeeting(id)
      if (!full) return null
      return { id: full.id, summaryPath: full.summaryPath, transcriptPath: full.transcriptPath }
    },
    summaryCaps: CONTACT_SUMMARY_CAPS,
    transcriptCaps: CONTACT_TRANSCRIPT_CAPS,
  })
  const hasMeetings = meetingsMd.length > 0
  if (hasMeetings) {
    parts.push(meetingsMd)
    parts.push('')
  }

  // Emails
  const emails = contactRepo.listContactEmails(contactId)
  const emailsMd = formatEmailsSection(emails, CONTACT_EMAIL_CAPS)
  const hasEmails = emailsMd.length > 0
  if (hasEmails) {
    parts.push(emailsMd)
    parts.push('')
  }

  // Notes
  const notes = _contactNotesRepo.list(contactId)
  const notesMd = formatNotesSection(notes, CONTACT_NOTE_CAPS)
  const hasNotes = notesMd.length > 0
  if (hasNotes) {
    parts.push(notesMd)
    parts.push('')
  }

  return {
    markdown: parts.join('\n'),
    hasMeetings,
    hasEmails,
    hasNotes,
  }
}

/** chatDispatch entry for contact chats. Wraps `assembleContactContext`
 *  with the empty-state policy: zero meetings + zero emails + zero notes →
 *  curated response, no LLM call. */
export function buildContactContext(opts: { contactId: string }): BuilderResult {
  let signals: ContactContextSignals
  try {
    signals = assembleContactContext(opts.contactId)
  } catch (err) {
    if (err instanceof Error && err.message === 'Contact not found') {
      return { kind: 'error', message: 'Contact not found' }
    }
    throw err
  }

  if (!signals.hasMeetings && !signals.hasEmails && !signals.hasNotes) {
    const contact = contactRepo.getContact(opts.contactId)
    const name = contact?.fullName ?? 'this contact'
    return {
      kind: 'response',
      text: `I have very little information about ${name} yet. Try syncing some emails, linking meetings, or adding notes first.`,
    }
  }

  return { kind: 'context', markdown: signals.markdown }
}

/** Per-kind system prompt — verbatim from legacy contact-chat.ts:14-18. */
export const CONTACT_SYSTEM_PROMPT = `You are a helpful CRM assistant.
You answer questions about a specific contact using all available context:
meeting notes and transcripts, email correspondence, and contact notes.
Answer accurately based on the provided context. If information isn't available, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

// ── Search results (multi-meeting from a search) ─────────────────────────

/**
 * Assemble context for a search-results chat (questions like "what did Priya
 * say about pricing across these 5 meetings?"). The wire format here is
 * intentionally different from formatMeetingsSection's ## Meeting Summaries
 * style:
 *
 *   ### "Title" (Date)
 *   Participants: ...
 *
 *   **Summary:**
 *   <summary>
 *
 *   **Notes:**
 *   <user notes from meeting>
 *
 *   **Transcript excerpt:**
 *   <excerpt; 1500 chars when summary exists, 3000 when not>
 *
 *   ---
 *
 * Each meeting block is followed by `\n---\n\n` (separator + blank). Up to 10
 * meetings included. The system prompt instructs the LLM to cite using
 * "In [Meeting Title] (Date):" — that prompt formatting depends on the
 * `### "..."` quoted title here, so don't change it without coordinating.
 */
export function assembleSearchResultsContext(meetingIds: string[]): string {
  const contextParts: string[] = []

  // Process up to 10 meetings (already ordered by search relevance)
  for (const id of meetingIds.slice(0, 10)) {
    const meeting = meetingRepo.getMeeting(id)
    if (!meeting) continue

    const parts: string[] = []
    parts.push(`### "${meeting.title}" (${new Date(meeting.date).toLocaleDateString()})`)

    if (meeting.speakerMap && Object.keys(meeting.speakerMap).length > 0) {
      parts.push(`Participants: ${Object.values(meeting.speakerMap).join(', ')}`)
    }
    parts.push('')

    // Prefer summary over transcript
    if (meeting.summaryPath) {
      const summary = readSummary(meeting.summaryPath)
      if (summary) {
        parts.push('**Summary:**')
        parts.push(summary)
        parts.push('')
      }
    }

    if (meeting.notes) {
      parts.push('**Notes:**')
      parts.push(meeting.notes)
      parts.push('')
    }

    if (meeting.transcriptPath) {
      const transcript = readTranscript(meeting.transcriptPath)
      if (transcript) {
        const excerptLength = meeting.summaryPath ? 1500 : 3000
        const excerpt = transcript.length > excerptLength
          ? transcript.substring(0, excerptLength) + '...'
          : transcript
        parts.push('**Transcript excerpt:**')
        parts.push(excerpt)
        parts.push('')
      }
    }

    if (parts.length > 2) {
      contextParts.push(parts.join('\n'))
      contextParts.push('---')
      contextParts.push('')
    }
  }

  return contextParts.join('\n')
}

/** chatDispatch entry for search-results chats. Empty input → curated
 *  response. No-loadable-meetings → different curated response (preserves
 *  existing behavior). */
export function buildSearchResultsContext(opts: { meetingIds: string[] }): BuilderResult {
  if (opts.meetingIds.length === 0) {
    return { kind: 'response', text: 'No meetings in the search results to query.' }
  }

  const markdown = assembleSearchResultsContext(opts.meetingIds)
  if (!markdown) {
    return {
      kind: 'response',
      text: "I couldn't load any data from the search result meetings. Please check that transcripts exist.",
    }
  }
  return { kind: 'context', markdown }
}

/** Per-kind system prompt — verbatim from legacy chat.ts:30-35. */
export const SEARCH_RESULTS_SYSTEM_PROMPT = `You are a helpful assistant that answers questions about the user's meeting search results.
You have access to summaries, notes, and transcript excerpts from the meetings the user found via search.
Answer questions accurately based on the content provided.
Always cite which meeting the information comes from using the format: "In [Meeting Title] (Date):".
If the information isn't in any of the provided meetings, say so.
Be concise but thorough. Use bullet points when listing multiple items.`

/** Footer appended to the user prompt for search-results chats — preserves
 *  the legacy template's citation reminder. */
export const SEARCH_RESULTS_QUESTION_FOOTER =
  'Please answer based on the meeting content above. Cite the meeting title and date when referencing specific information.'

// ── Global (cross-CRM + meetings) ────────────────────────────────────────
//
// The global path's assembly logic stays in crm-chat.ts (where it composes
// buildMeetingContext from chat.ts + buildCrmContext from crm-chat.ts).
// Keeping it there avoids a context-builders.ts ↔ chat.ts ↔ crm-chat.ts
// import cycle that broke vi.mock interception in the parity test.
// context-builders.ts only owns the system prompts for global / CRM-only.

/** System prompts — verbatim from legacy crm-chat.ts:47-58. */
export const QUERY_ALL_SYSTEM_PROMPT = `You are a research assistant for a venture capital firm.
You have access to meeting transcripts/notes AND the firm's full CRM database (contacts, companies, emails, notes).
Synthesize information from both sources to answer the question.
When listing multiple people or organizations, format your answer as a markdown table with the most relevant columns.
Cite sources: for meeting-sourced info, mention the meeting title and date.
If information isn't available in either source, say so clearly — do not invent data.`

export const CRM_SYSTEM_PROMPT = `You are a research assistant for a venture capital firm.
You have access to the firm's CRM: contacts, companies/funds, emails, and notes.
Answer questions accurately based only on the provided data.
When listing multiple people or organizations, format your answer as a markdown table with the most relevant columns.
If nothing in the database matches the query, say so clearly — do not invent data.`
