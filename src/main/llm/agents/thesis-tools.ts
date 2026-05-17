/**
 * Tool registry for the Investment Thesis Stress-Test Agent.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Tools by category:                                              │
 *   │   internal_read:                                                 │
 *   │     - read_existing_memo, get_company_overview                  │
 *   │     - list_meetings, read_meeting_summary, read_meeting_transcript│
 *   │     - list_notes, read_note                                      │
 *   │     - list_emails, read_email                                    │
 *   │     - list_drive_files, read_drive_file                          │
 *   │     - list_company_contacts, read_contact_profile                │
 *   │   web:                                                            │
 *   │     - web_search, web_fetch (URL allowlist enforced inside)      │
 *   │   terminal:                                                       │
 *   │     - submit_review (the agent's stop signal — produces a Report)│
 *   │                                                                 │
 *   │  ctx.companyId is the run's pinned company. Tools that take a    │
 *   │  `companyId` param ignore any model-supplied value and use ctx — │
 *   │  defense-in-depth against cross-company data leak (review        │
 *   │  decision: cross-company guardrail).                              │
 *   └────────────────────────────────────────────────────────────────┘
 */

import { defineTool, z, type Tool, type ToolContext } from './define-tool'
import { SubmitReviewInputSchema } from '../../../shared/types/stress-test-report'
import { agentWebSearch, agentWebFetch } from '../../services/exa-research'
import { normalizeLegacyHeadings } from '../memo/sections'

import * as companyRepo from '@cyggie/db/sqlite/repositories/org-company.repo'
import * as memoRepo from '@cyggie/db/sqlite/repositories/investment-memo.repo'
import * as meetingRepo from '@cyggie/db/sqlite/repositories/meeting.repo'
import * as contactRepo from '@cyggie/db/sqlite/repositories/contact.repo'
import { getFlaggedFiles } from '@cyggie/db/sqlite/repositories/company-file-flags.repo'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'
import { readSummary, readTranscript, readLocalFile } from '../../storage/file-manager'

const _companyNotesRepo = makeEntityNotesRepo('company_id')

// ─── Internal-read tools ─────────────────────────────────────────────────

const readExistingMemo = defineTool({
  name: 'read_existing_memo',
  description:
    'Read the latest version of the investment memo for the company. Always call this first when stress-testing.',
  input: z.object({}),
  output: { maxChars: 12_000 },
  handler: (_input, ctx: ToolContext) => {
    const memo = memoRepo.getLatestMemoForCompany(ctx.companyId)
    if (!memo || !memo.latestVersion) return { error: 'no_memo_yet' }
    // Transparently rewrite pre-rename "## Investment Highlights" headings
    // to "## Investment Thesis" so the agent operates on the current section
    // roster regardless of which memo version it's stress-testing. Persisted
    // markdown on disk stays untouched (history preserved).
    return {
      memoId: memo.id,
      versionNumber: memo.latestVersion.versionNumber,
      contentMarkdown: normalizeLegacyHeadings(memo.latestVersion.contentMarkdown),
      changeNote: memo.latestVersion.changeNote,
      createdAt: memo.latestVersion.createdAt,
    }
  },
})

const getCompanyOverview = defineTool({
  name: 'get_company_overview',
  description:
    'Get the company record: name, domain, stage, round, raise size, post-money, location, industry, themes, description.',
  input: z.object({}),
  output: { maxChars: 2_000 },
  handler: (_input, ctx) => {
    const c = companyRepo.getCompany(ctx.companyId)
    if (!c) return { error: 'company_not_found' }
    return {
      name: c.canonicalName,
      domain: c.primaryDomain,
      website: c.websiteUrl,
      description: c.description,
      stage: c.stage,
      round: c.round,
      raiseSize: c.raiseSize,
      postMoneyValuation: c.postMoneyValuation,
      city: c.city,
      state: c.state,
      industry: c.industry,
      themes: c.themes,
    }
  },
})

const listMeetings = defineTool({
  name: 'list_meetings',
  description:
    'List meetings for the company. Returns id, title, date, and whether a summary or transcript is available. Use to decide which meetings to read.',
  input: z.object({}),
  output: { maxChars: 4_000 },
  handler: (_input, ctx) => {
    const meetings = companyRepo.listCompanyMeetings(ctx.companyId)
    const summaryPaths = companyRepo.listCompanyMeetingSummaryPaths(ctx.companyId)
    const summaryByMeetingId = new Map(summaryPaths.map(s => [s.meetingId, s.summaryPath]))
    return meetings.map(m => ({
      id: m.id,
      title: m.title,
      date: m.date,
      hasSummary: summaryByMeetingId.has(m.id),
      hasTranscript: true, // listCompanyMeetings only returns meetings with content
    }))
  },
})

const readMeetingSummary = defineTool({
  name: 'read_meeting_summary',
  description: 'Read the AI summary for a specific meeting. Prefer over transcript when available.',
  input: z.object({ meetingId: z.string().min(1) }),
  output: { maxChars: 8_000 },
  handler: ({ meetingId }, ctx) => {
    // Cross-company guardrail: verify meeting is actually linked to ctx.companyId.
    const summaryPaths = companyRepo.listCompanyMeetingSummaryPaths(ctx.companyId)
    const path = summaryPaths.find(s => s.meetingId === meetingId)
    if (!path) return { error: 'no_summary_for_meeting' }
    const content = readSummary(path.summaryPath)
    if (!content) return { error: 'summary_file_unreadable' }
    return { meetingId, title: path.title, date: path.date, content }
  },
})

const readMeetingTranscript = defineTool({
  name: 'read_meeting_transcript',
  description:
    'Read the raw transcript for a meeting. Heavy — prefer read_meeting_summary if a summary exists.',
  input: z.object({ meetingId: z.string().min(1) }),
  output: { maxChars: 12_000 },
  handler: ({ meetingId }, ctx) => {
    // Verify the meeting is linked to ctx.companyId before reading.
    const linkedMeetings = companyRepo.listCompanyMeetings(ctx.companyId)
    if (!linkedMeetings.find(m => m.id === meetingId)) return { error: 'meeting_not_linked_to_company' }
    const meeting = meetingRepo.getMeeting(meetingId)
    if (!meeting?.transcriptPath) return { error: 'no_transcript_path' }
    const content = readTranscript(meeting.transcriptPath)
    if (!content) return { error: 'transcript_file_unreadable' }
    return { meetingId, title: meeting.title, date: meeting.date, content }
  },
})

const listNotes = defineTool({
  name: 'list_notes',
  description: 'List notes attached to the company. Returns id + title + 200-char snippet of each.',
  input: z.object({}),
  output: { maxChars: 6_000 },
  handler: (_input, ctx) => {
    const notes = _companyNotesRepo.list(ctx.companyId)
    return notes.map(n => ({
      id: n.id,
      title: n.title ?? null,
      snippet: (n.content ?? '').slice(0, 200),
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }))
  },
})

const readNote = defineTool({
  name: 'read_note',
  description: 'Read the full body of a note by id.',
  input: z.object({ noteId: z.string().min(1) }),
  output: { maxChars: 6_000 },
  handler: ({ noteId }, ctx) => {
    const note = _companyNotesRepo.get(noteId)
    if (!note) return { error: 'note_not_found' }
    // Cross-company guardrail: a Note is keyed by company_id; if the note's
    // company_id doesn't match ctx.companyId, refuse.
    const linkedNotes = _companyNotesRepo.list(ctx.companyId)
    if (!linkedNotes.find(n => n.id === noteId)) return { error: 'note_not_linked_to_company' }
    return { id: note.id, title: note.title, content: note.content, createdAt: note.createdAt }
  },
})

const listEmails = defineTool({
  name: 'list_emails',
  description:
    'List emails linked to the company. Returns subject + from + date metadata only — no bodies. Capped at 30. Call read_email to get a specific body.',
  input: z.object({}),
  output: { maxChars: 4_000 },
  handler: (_input, ctx) => {
    const emails = companyRepo.listCompanyEmails(ctx.companyId).slice(0, 30)
    return emails.map(e => ({
      id: e.id,
      subject: e.subject,
      from: e.fromEmail,
      date: e.receivedAt ?? e.sentAt,
    }))
  },
})

const readEmail = defineTool({
  name: 'read_email',
  description: 'Read the body of a specific email by message id.',
  input: z.object({ messageId: z.string().min(1) }),
  output: { maxChars: 6_000 },
  handler: ({ messageId }, ctx) => {
    // Cross-company guardrail: must be in the company's email set.
    const linkedEmails = companyRepo.listCompanyEmails(ctx.companyId)
    if (!linkedEmails.find(e => e.id === messageId)) {
      return { error: 'email_not_linked_to_company' }
    }
    const email = companyRepo.getCompanyEmailById(messageId)
    if (!email) return { error: 'email_not_found' }
    return {
      id: email.id,
      subject: email.subject,
      from: email.fromEmail,
      date: email.receivedAt ?? email.sentAt,
      body: email.bodyText ?? '',
    }
  },
})

const listDriveFiles = defineTool({
  name: 'list_drive_files',
  description: 'List Google Drive files flagged on the company (pitch decks, models, etc.).',
  input: z.object({}),
  output: { maxChars: 3_000 },
  handler: (_input, ctx) => {
    const files = getFlaggedFiles(ctx.companyId)
    return files.map(f => ({
      id: f.fileId,
      name: f.fileName,
      mimeType: f.mimeType,
    }))
  },
})

const readDriveFile = defineTool({
  name: 'read_drive_file',
  description: 'Read the extracted text content of a drive file (PDF / docx / etc.).',
  input: z.object({ fileId: z.string().min(1) }),
  output: { maxChars: 10_000 },
  handler: async ({ fileId }, ctx) => {
    const linked = getFlaggedFiles(ctx.companyId)
    const ref = linked.find(f => f.fileId === fileId)
    if (!ref) return { error: 'file_not_linked_to_company' }
    const content = await readLocalFile(ref.fileId, ref.mimeType ?? undefined)
    if (!content) return { error: 'file_unreadable_or_missing' }
    return { id: ref.fileId, name: ref.fileName, content }
  },
})

const listCompanyContacts = defineTool({
  name: 'list_company_contacts',
  description: 'List contacts linked to the company. Returns id + name + title.',
  input: z.object({}),
  output: { maxChars: 3_000 },
  handler: (_input, ctx) => {
    const contacts = companyRepo.listCompanyContacts(ctx.companyId)
    return contacts.map(c => ({
      id: c.id,
      name: c.fullName,
      title: c.title,
      email: c.email,
      linkedinUrl: c.linkedinUrl,
    }))
  },
})

const readContactProfile = defineTool({
  name: 'read_contact_profile',
  description:
    'Read the full profile for a contact, including LinkedIn-derived fields (title, seniority, etc.) when available.',
  input: z.object({ contactId: z.string().min(1) }),
  output: { maxChars: 4_000 },
  handler: ({ contactId }, ctx) => {
    // Cross-company guardrail.
    const linked = companyRepo.listCompanyContacts(ctx.companyId)
    if (!linked.find(c => c.id === contactId)) {
      return { error: 'contact_not_linked_to_company' }
    }
    const contact = contactRepo.getContact(contactId)
    if (!contact) return { error: 'contact_not_found' }
    return {
      id: contact.id,
      fullName: contact.fullName,
      email: contact.email,
      title: contact.title,
      linkedinUrl: contact.linkedinUrl,
      keyTakeaways: contact.keyTakeaways,
    }
  },
})

// ─── Web tools ───────────────────────────────────────────────────────────

const webSearch = defineTool({
  name: 'web_search',
  description:
    'Search the web for recent news, market data, competitor info, or founder background. Returns top 5 snippets. Limited per run; use deliberately.',
  category: 'web',
  input: z.object({ query: z.string().min(2) }),
  output: { maxChars: 9_000 },
  handler: async ({ query }) => agentWebSearch(query),
})

const webFetch = defineTool({
  name: 'web_fetch',
  description:
    'Fetch the full content of a specific URL (typically discovered via web_search). https-only; private IPs and non-https are rejected.',
  category: 'web',
  input: z.object({ url: z.string().url() }),
  output: { maxChars: 10_000 },
  handler: async ({ url }) => agentWebFetch(url),
})

// ─── Terminal tool ───────────────────────────────────────────────────────

const submitReview = defineTool({
  name: 'submit_review',
  description:
    "Submit the stress-test report. You do NOT rewrite the memo — produce a structured write-up of weaknesses. Required: a summary, a recommendation (proceed | proceed_with_caveats | pass | dig_deeper), and 3–8 numbered concerns. Each concern names the analyst's claim, the evidence weakening it, and what would need to be true for the original thesis to hold. Use evidence[] with isCritique=true for claim-level flags tied to specific sources. After this call the agent loop terminates.",
  terminal: true,
  category: 'terminal',
  input: SubmitReviewInputSchema,
  output: { maxChars: 100 },
  handler: () => ({ ok: true }),
})

// ─── Registry export ─────────────────────────────────────────────────────

// Note: each defineTool() returns Tool<SpecificI, SpecificO> which doesn't
// satisfy Tool<unknown, unknown> due to input contravariance. The registry
// is heterogeneous by design — the agent loop dispatches via tool.dispatch(),
// which takes raw input and runs Zod validation, so the public surface is
// type-erased. Use Tool[] (defaults to Tool<unknown, unknown>) at the
// boundary and cast.

export const THESIS_STRESS_TEST_TOOLS: Tool[] = [
  readExistingMemo,
  getCompanyOverview,
  listMeetings,
  readMeetingSummary,
  readMeetingTranscript,
  listNotes,
  readNote,
  listEmails,
  readEmail,
  listDriveFiles,
  readDriveFile,
  listCompanyContacts,
  readContactProfile,
  webSearch,
  webFetch,
  submitReview,
] as unknown as Tool[]

export const SUBMIT_REVIEW_TOOL_NAME = submitReview.name
