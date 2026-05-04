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

import { formatMeetingsSection, formatEmailsSection, formatFlaggedFilesSection, type SectionCaps } from './context-formatters'
import * as companyRepo from '../database/repositories/org-company.repo'
import * as meetingRepo from '../database/repositories/meeting.repo'
import { getFlaggedFileIds } from '../database/repositories/company-file-flags.repo'

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
