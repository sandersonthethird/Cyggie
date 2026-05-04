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
import * as companyRepo from '../database/repositories/org-company.repo'
import * as contactRepo from '../database/repositories/contact.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { makeEntityNotesRepo } from '../database/repositories/notes-base'
import { getFlaggedFileIds } from '../database/repositories/company-file-flags.repo'

const _contactNotesRepo = makeEntityNotesRepo('contact_id')

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
  hasFlaggedFiles: boolean
}

// Caps preserved verbatim from the legacy queryCompany code in
// company-chat.ts:25-31. Keep these per-kind — different surfaces budget
// emails / files differently.
const COMPANY_SUMMARY_CAPS: SectionCaps = { perItem: 8_000, total: 30_000 }
const COMPANY_TRANSCRIPT_CAPS: SectionCaps = { perItem: 3_000, total: Number.MAX_SAFE_INTEGER }
const COMPANY_EMAIL_CAPS: SectionCaps = { perItem: 2_000, total: 15_000, maxItems: 20 }
const COMPANY_FILE_CAPS: SectionCaps = { perItem: 6_000, total: 30_000 }

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

  // Flagged files
  const flaggedIds = getFlaggedFileIds(companyId)
  const filesMd = await formatFlaggedFilesSection(flaggedIds, COMPANY_FILE_CAPS)
  const hasFlaggedFiles = filesMd.length > 0
  if (hasFlaggedFiles) {
    parts.push(filesMd)
    parts.push('')
  }

  return {
    markdown: parts.join('\n'),
    hasMeetings,
    hasEmails,
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

  if (!signals.hasMeetings && !signals.hasEmails && !signals.hasFlaggedFiles) {
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

/** Per-kind system prompt — verbatim from legacy company-chat.ts:19-23.
 *  Exported alongside the builder so chatDispatch can pair them in step 8. */
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
