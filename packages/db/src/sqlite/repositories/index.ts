// =============================================================================
// repositories/index.ts — sync-wrapped barrel for owned-table repos.
//
// Production code MUST import owned-table writes from this barrel rather
// than directly from `*.repo.ts`. The barrel re-exports each write function
// wrapped in `withSync()` so the row + outbox entry land atomically.
//
// Reads pass through unchanged.
//
// Scope (Phase 1.5a):
//   Covers the four M2 entity repos:
//     - meeting.repo (meetings, meeting_speakers)
//     - contact.repo (contacts, contact_emails)
//     - org-company.repo (org_companies, org_company_aliases, meeting_company_links)
//     - notes.repo (notes, note_folders)
//
//   Other owned-table repos (task, template, pipeline-config, chat-session)
//   continue to export directly; mobile doesn't read those entities yet.
//   They'll be wrapped in a follow-up commit when the corresponding mobile
//   screens land in M4–M5.
//
// Known gap — multi-table cascades:
//   Some operations write to multiple owned tables (e.g. `createMeeting`
//   updates `meeting_company_links` via `syncMeetingCompanyLinks`,
//   `mergeContacts` rewires emails+links). Without better-sqlite3's
//   update_hook, the wrapper can't auto-emit outbox rows for those side-
//   effect tables. The PRIMARY entity row (meeting / contact / company /
//   note) is always emitted; cascading link/email tables stay un-emitted
//   in V1. Mobile views refresh on focus, so the eventual-consistency
//   window is one TanStack refetch. Bulk operations
//   (`autoLinkContactsByDomain`, `mergeContacts`, `applyContactDedupDecisions`,
//   `enrichExistingContacts`, etc.) bypass the wrapper entirely — they're
//   not yet sync-aware.
//
//   Exception — `note_folders`: deleteFolder + renameFolder DO emit
//   cascade rows. The raw repo functions call `appendOutboxRow` directly
//   for every nested descendant (delete) and for the DELETE-old + INSERT-new
//   pairs (rename, since `path` is the PK and a rename isn't an UPDATE).
//
// Adding a new wrapped fn:
//   1. Make sure the table is in `OWNED_TABLES` (packages/db/src/sync/
//      owned-tables.ts).
//   2. Wrap with `withSync()` here. Use `extractRow` if the inner fn
//      returns something other than the row (e.g. void or a count).
//   3. For deletes, supply `captureBeforeDelete` to SELECT the row before
//      the inner fn removes it (the outbox payload needs the pre-delete state).
// =============================================================================

import { withSync } from './_sync'
import * as rawMeeting from './meeting.repo'
import * as rawContact from './contact.repo'
import * as rawOrgCompany from './org-company.repo'
import * as rawNotes from './notes.repo'
import * as rawChatSession from './chat-session.repo'
import * as rawMemo from './investment-memo.repo'
import * as rawFlaggedFiles from './company-file-flags.repo'
import type { InvestmentMemoWithLatest } from '@shared/types/company'
import { getDatabase } from '../connection'

// ── meetings ────────────────────────────────────────────────────────────────
//
// createMeeting / updateMeeting / deleteMeeting are wrapped. The inner
// `createMeeting` also writes meeting_company_links via syncMeetingCompanyLinks —
// that cascade is un-emitted in V1 (see file header). Mobile shows the
// linked companies via the jsonb `companies` field on the meeting row itself,
// which IS captured in the meetings outbox payload, so the user sees the
// correct list on the meeting detail screen.

export const createMeeting = withSync(rawMeeting.createMeeting, {
  table: 'meetings',
  op: 'insert',
})

export const updateMeeting = withSync(rawMeeting.updateMeeting, {
  table: 'meetings',
  op: 'update',
  // T38: snapshot meeting state before the update so the wrapper can
  // diff large JSONB columns (transcriptSegments, chatMessages, summary,
  // notes) against post-update and omit unchanged ones from the outbox
  // payload. Keeps a status-flip or title-rename from dragging a 5 MB
  // transcript across the wire on every change.
  captureBeforeUpdate: (_db, [id]) =>
    rawMeeting.getMeeting(id) as unknown as Record<string, unknown> | null,
})

export const deleteMeeting = withSync(rawMeeting.deleteMeeting, {
  table: 'meetings',
  op: 'delete',
  captureBeforeDelete: (_db, [id]) =>
    rawMeeting.getMeeting(id) as unknown as Record<string, unknown> | null,
})

// meeting_speaker_contact_links is a composite-PK join table (meeting_id,
// speaker_index). Without wrapping, the speaker-tag IPC handler's raw
// INSERT/DELETE never reached the outbox, so mobile never saw which contact
// a speaker was tagged as — Last Touch / Meetings tab broke. Both fns return
// void; the row we want in the outbox is the link itself.
export const linkMeetingSpeakerContact = withSync(
  rawMeeting.linkMeetingSpeakerContact,
  {
    table: 'meeting_speaker_contact_links',
    op: 'insert',
    extractRow: ({ args }) => ({
      meeting_id: args[0],
      speaker_index: args[1],
      contact_id: args[2],
    }),
  },
)

export const unlinkMeetingSpeakerContact = withSync(
  rawMeeting.unlinkMeetingSpeakerContact,
  {
    table: 'meeting_speaker_contact_links',
    op: 'delete',
    captureBeforeDelete: (db, [meetingId, speakerIndex]) => {
      const row = db
        .prepare(
          `SELECT * FROM meeting_speaker_contact_links WHERE meeting_id = ? AND speaker_index = ?`,
        )
        .get(meetingId, speakerIndex)
      return row as Record<string, unknown> | null
    },
  },
)

// Pass-throughs (read-only or owned-table-irrelevant)
export const findMeetingByCalendarEventId = rawMeeting.findMeetingByCalendarEventId
export const getMeetingSpeakerContactMap = rawMeeting.getMeetingSpeakerContactMap
export const getMeeting = rawMeeting.getMeeting
export const listMeetings = rawMeeting.listMeetings
export const cleanupStaleRecordings = rawMeeting.cleanupStaleRecordings
export const cleanupExpiredScheduledMeetings = rawMeeting.cleanupExpiredScheduledMeetings

// Group-event ingestion gate (migration 098). Read-only / pure helpers pass through.
// Writes to is_group_event{,_user_set} go through the existing wrapped updateMeeting
// so the sync agent picks them up automatically.
export const shouldSyncAttendees = rawMeeting.shouldSyncAttendees
export const computeAutoGroupEventFlag = rawMeeting.computeAutoGroupEventFlag

// ── contacts ────────────────────────────────────────────────────────────────

export const createContact = withSync(rawContact.createContact, {
  table: 'contacts',
  op: 'insert',
})

export const updateContact = withSync(rawContact.updateContact, {
  table: 'contacts',
  op: 'update',
})

// contact_emails is a composite-PK table (contact_id, email). The raw repo
// functions all return a `ContactDetail` (contact-shaped), so we must
// `extractRow` a `contact_emails`-shaped row by re-reading from the table
// — otherwise `encodeRowId` throws "missing primary key column 'contact_id'".
//
// updateContactEmail caveat: this is a delete-old + insert-new at the PK
// level (because `email` is part of the PK), but we only emit ONE outbox
// row for the new key. The OLD `(contact_id, oldEmail)` row will stay
// orphaned on the gateway side until a follow-up properly emits the cascade
// delete from inside the raw repo. Single-firm beta acceptable; fix when
// updateContactEmail UI sees real use.
export const addContactEmail = withSync(rawContact.addContactEmail, {
  table: 'contact_emails',
  op: 'insert',
  extractRow: ({ args }) =>
    rawContact.getContactEmailRow(args[0] as string, args[1] as string) as
      | Record<string, unknown>
      | null,
})

export const updateContactEmail = withSync(rawContact.updateContactEmail, {
  table: 'contact_emails',
  op: 'update',
  extractRow: ({ args }) =>
    rawContact.getContactEmailRow(args[0] as string, args[2] as string) as
      | Record<string, unknown>
      | null,
})

export const removeContactEmail = withSync(rawContact.removeContactEmail, {
  table: 'contact_emails',
  op: 'delete',
  // The row no longer exists post-delete; gateway only needs the PK columns
  // to build its `DELETE … WHERE contact_id = ? AND email = ?`. Email is
  // lowercased to match the SQLite-side normalization done by the raw fn.
  extractRow: ({ args }) => {
    const contactId = args[0] as string
    const emailInput = args[1] as string
    const email = emailInput.trim().toLowerCase()
    if (!contactId || !email) return null
    return { contact_id: contactId, email }
  },
})

export const setContactPrimaryCompany = withSync(
  rawContact.setContactPrimaryCompany,
  {
    table: 'contacts',
    op: 'update',
    // setContactPrimaryCompany returns void — re-read the contact for the payload.
    extractRow: ({ args }) =>
      rawContact.getContact(args[0]) as unknown as Record<string, unknown> | null,
  },
)

// User-initiated hard delete (migration 098). The IPC layer wraps this in its
// own transaction with the tombstone INSERT so both land atomically. Internal
// callers (merge) go directly through deleteContactById and don't tombstone.
export const deleteContact = withSync(rawContact.deleteContact, {
  table: 'contacts',
  op: 'delete',
  captureBeforeDelete: (_db, [id]) =>
    rawContact.getContact(id) as unknown as Record<string, unknown> | null,
})

// Pass-throughs (reads + bulk un-wrapped operations — see file header gap)
export const listContacts = rawContact.listContacts
export const listContactsLight = rawContact.listContactsLight
export const listContactsForEmailOnboarding = rawContact.listContactsForEmailOnboarding
export const hasContactEmailHistory = rawContact.hasContactEmailHistory
export const getContact = rawContact.getContact
export const listContactEmails = rawContact.listContactEmails
export const listContactEmailMessagesForChat = rawContact.listContactEmailMessagesForChat
export const autoLinkContactsByDomain = rawContact.autoLinkContactsByDomain
export const syncContactsFromAttendees = rawContact.syncContactsFromAttendees
export const syncContactsFromMeetings = rawContact.syncContactsFromMeetings
export const enrichExistingContacts = rawContact.enrichExistingContacts
export const enrichContact = rawContact.enrichContact
export const enrichContactsByIds = rawContact.enrichContactsByIds
export const listPastEmployeeContacts = rawContact.listPastEmployeeContacts
export const resolveContactsByEmails = rawContact.resolveContactsByEmails
export const resolveContactsByLowercasedNames = rawContact.resolveContactsByLowercasedNames
export const getContactsByIds = rawContact.getContactsByIds
export const resolveContactsByNormalizedNames = rawContact.resolveContactsByNormalizedNames
export const mergeContacts = rawContact.mergeContacts
export const listSuspectedDuplicateContacts = rawContact.listSuspectedDuplicateContacts
export const applyContactDedupDecisions = rawContact.applyContactDedupDecisions
export const listContactTimeline = rawContact.listContactTimeline

// ── org_companies ───────────────────────────────────────────────────────────

export const createCompany = withSync(rawOrgCompany.createCompany, {
  table: 'org_companies',
  op: 'insert',
})

export const updateCompany = withSync(rawOrgCompany.updateCompany, {
  table: 'org_companies',
  op: 'update',
})

export const deleteCompany = withSync(rawOrgCompany.deleteCompany, {
  table: 'org_companies',
  op: 'delete',
  captureBeforeDelete: (_db, [id]) =>
    rawOrgCompany.getCompany(id) as unknown as Record<string, unknown> | null,
})

// getOrCreateCompanyByName MAY insert; for outbox correctness we treat it as
// insert but only emit when a new row is actually created. The inner fn
// returns { companyId, created: boolean } — the wrapper's default extractRow
// fires regardless, so we override and skip emission when created=false.
export const getOrCreateCompanyByName = withSync(
  rawOrgCompany.getOrCreateCompanyByName,
  {
    table: 'org_companies',
    op: 'insert',
    extractRow: ({ result }) => {
      const r = result as unknown as { companyId: string; created: boolean }
      if (!r || !r.created) return null // no-op; existing row used
      return rawOrgCompany.getCompany(r.companyId) as unknown as Record<
        string,
        unknown
      > | null
    },
  },
)

// linkMeetingCompany / unlinkMeetingCompany operate on meeting_company_links
// (composite PK: meeting_id, company_id).
export const linkMeetingCompany = withSync(rawOrgCompany.linkMeetingCompany, {
  table: 'meeting_company_links',
  op: 'insert',
  // linkMeetingCompany returns void; the row we want is the link itself.
  extractRow: ({ args }) => ({
    meeting_id: args[0],
    company_id: args[1],
  }),
})

export const unlinkMeetingCompany = withSync(
  rawOrgCompany.unlinkMeetingCompany,
  {
    table: 'meeting_company_links',
    op: 'delete',
    captureBeforeDelete: (db, [meetingId, companyId]) => {
      const row = db
        .prepare(
          `SELECT * FROM meeting_company_links WHERE meeting_id = ? AND company_id = ?`,
        )
        .get(meetingId, companyId)
      return row as Record<string, unknown> | null
    },
  },
)

// Pass-throughs (reads + bulk)
export const parseInvestorsJson = rawOrgCompany.parseInvestorsJson
export const listCompanies = rawOrgCompany.listCompanies
export const countStubCompanies = rawOrgCompany.countStubCompanies
export const listPipelineCompanies = rawOrgCompany.listPipelineCompanies
export const getCompaniesByNormalizedNames = rawOrgCompany.getCompaniesByNormalizedNames
export const getCompany = rawOrgCompany.getCompany
export const getCompanyInvestorsByType = rawOrgCompany.getCompanyInvestorsByType
export const getCoInvestorOverlaps = rawOrgCompany.getCoInvestorOverlaps
export const setCompanyInvestors = rawOrgCompany.setCompanyInvestors
export const findCompanyIdByDomain = rawOrgCompany.findCompanyIdByDomain
export const getCompanyCanonicalNameByDomain =
  rawOrgCompany.getCompanyCanonicalNameByDomain
export const findCompanyIdByNameOrDomain = rawOrgCompany.findCompanyIdByNameOrDomain
export const getEntityTypeByNameOrDomain = rawOrgCompany.getEntityTypeByNameOrDomain
export const upsertCompanyClassification = rawOrgCompany.upsertCompanyClassification
export const getCompanyMergePreview = rawOrgCompany.getCompanyMergePreview
export const mergeCompanies = rawOrgCompany.mergeCompanies
export const listSuspectedDuplicateCompanies =
  rawOrgCompany.listSuspectedDuplicateCompanies
export const applyCompanyDedupDecisions = rawOrgCompany.applyCompanyDedupDecisions
export const linkMeetingsForContactCompany = rawOrgCompany.linkMeetingsForContactCompany
export const listCompanyMeetings = rawOrgCompany.listCompanyMeetings
export const listMeetingCompanies = rawOrgCompany.listMeetingCompanies
export const listCompanyMeetingSummaryPaths = rawOrgCompany.listCompanyMeetingSummaryPaths
// Additional read / linkage helpers used by the desktop IPC layer. These
// were missed when the barrel was first carved out; pass-through-exported
// here so the IPC files can import them through the barrel like everything
// else. None of them mutate owned tables in a way the wrapper needs to
// observe (link/unlink-contact go through company_contacts join writes
// which aren't owned in 1.5a scope).
//
// (listMeetingCompanies + listCompanyMeetingSummaryPaths are already
// re-exported above; do not duplicate here.)
export const listCompanyContacts = rawOrgCompany.listCompanyContacts
export const listCompanyEmails = rawOrgCompany.listCompanyEmails
export const listCompanyEmailMessagesForChat = rawOrgCompany.listCompanyEmailMessagesForChat
export const listCompanyFiles = rawOrgCompany.listCompanyFiles
export const listCompanyTimeline = rawOrgCompany.listCompanyTimeline
export const setCompanyPrimaryContact = rawOrgCompany.setCompanyPrimaryContact
export const clearCompanyPrimaryContact = rawOrgCompany.clearCompanyPrimaryContact
export const linkContactToCompany = rawOrgCompany.linkContactToCompany
export const unlinkContactFromCompany = rawOrgCompany.unlinkContactFromCompany
export const deleteCompanyEmailLinks = rawOrgCompany.deleteCompanyEmailLinks
export const getCompanyEmailById = rawOrgCompany.getCompanyEmailById
export const fixConcatenatedCompanyNames =
  rawOrgCompany.fixConcatenatedCompanyNames
export const repairContactCompanyMismatches =
  rawOrgCompany.repairContactCompanyMismatches

// ── notes ───────────────────────────────────────────────────────────────────

export const createNote = withSync(rawNotes.createNote, {
  table: 'notes',
  op: 'insert',
})

export const updateNote = withSync(rawNotes.updateNote, {
  table: 'notes',
  op: 'update',
})

// tagNote returns void — refetch the note for the outbox payload.
export const tagNote = withSync(rawNotes.tagNote, {
  table: 'notes',
  op: 'update',
  extractRow: ({ args }) =>
    rawNotes.getNote(args[0]) as unknown as Record<string, unknown> | null,
})

export const deleteNote = withSync(rawNotes.deleteNote, {
  table: 'notes',
  op: 'delete',
  captureBeforeDelete: (_db, [noteId]) =>
    rawNotes.getNote(noteId) as unknown as Record<string, unknown> | null,
})

export const createFolder = withSync(rawNotes.createFolder, {
  table: 'note_folders',
  op: 'insert',
  // createFolder returns void — the row is { path }
  extractRow: ({ args }) => ({ path: args[0] }),
})

// Pass-throughs (reads)
export const listNotes = rawNotes.listNotes
export const searchNotes = rawNotes.searchNotes
export const getNote = rawNotes.getNote
export const listFolders = rawNotes.listFolders
export const getFolderCounts = rawNotes.getFolderCounts
export const listImportSources = rawNotes.listImportSources

// renameFolder: a PK rename is DELETE old + INSERT new in the outbox protocol.
// The wrapper emits the INSERT for the new root path; the raw repo emits a
// DELETE for each old path it removed (plus INSERTs for cascaded children).
export const renameFolder = withSync(rawNotes.renameFolder, {
  table: 'note_folders',
  op: 'insert',
  extractRow: ({ args }) => ({ path: args[1] }), // newPath
})

// deleteFolder: wrapper emits the root delete; raw repo emits one cascade
// delete per nested descendant path inside the same transaction.
export const deleteFolder = withSync(rawNotes.deleteFolder, {
  table: 'note_folders',
  op: 'delete',
  captureBeforeDelete: (_db, [path]) => ({ path }),
})

// ── chat sessions (T17a) ────────────────────────────────────────────────────
//
// chat_sessions + chat_session_messages are both in OWNED_TABLES. Writes
// flow through these wrapped exports so they reach Neon via the Phase 1.5a
// outbox.
//
// Known gap (same pattern as createMeeting's meeting_company_links cascade):
//   appendMessage INSERTs a row in chat_session_messages AND issues a
//   cascading UPDATE on chat_sessions (message_count + last_message_at +
//   preview_text). The wrapper emits ONE outbox entry — the new message
//   row in chat_session_messages. The cascading session-row update is
//   un-emitted; mobile picks up the new message_count / last_message_at
//   on its next refetch of the sessions list, which is the existing
//   eventual-consistency contract.
//
//   createNew also internally calls endActive (which UPDATEs the previously-
//   active session's is_active=0, or DELETEs it if empty). Same pattern:
//   the wrapper emits the INSERT for the new session; the old-session
//   transition is un-emitted. Mobile sees it via refetch.

// createNew INSERTs a new active chat_sessions row (and demotes any prior
// active one for the same contextId via internal endActive).
export const createChatSession = withSync(rawChatSession.createNew, {
  table: 'chat_sessions',
  op: 'insert',
})

// appendMessage INSERTs into chat_session_messages. The cascading session-
// row update is intentionally un-emitted (see header note).
export const appendChatMessage = withSync(rawChatSession.appendMessage, {
  table: 'chat_session_messages',
  op: 'insert',
})

// rename returns ChatSession | null. The wrapper expects a row; extractRow
// re-reads the session post-update to keep payload shape consistent even
// when the call updated 0 rows (caller passes an unknown sessionId).
export const renameChatSession = withSync(rawChatSession.rename, {
  table: 'chat_sessions',
  op: 'update',
  extractRow: ({ args }) =>
    rawChatSession.getSession(args[0]) as unknown as Record<string, unknown> | null,
})

// setTitleIfMissing returns void; re-read.
export const setChatSessionTitleIfMissing = withSync(
  rawChatSession.setTitleIfMissing,
  {
    table: 'chat_sessions',
    op: 'update',
    extractRow: ({ args }) =>
      rawChatSession.getSession(args[0]) as unknown as Record<string, unknown> | null,
  },
)

export const pinChatSession = withSync(rawChatSession.pin, {
  table: 'chat_sessions',
  op: 'update',
  extractRow: ({ args }) =>
    rawChatSession.getSession(args[0]) as unknown as Record<string, unknown> | null,
})

export const unpinChatSession = withSync(rawChatSession.unpin, {
  table: 'chat_sessions',
  op: 'update',
  extractRow: ({ args }) =>
    rawChatSession.getSession(args[0]) as unknown as Record<string, unknown> | null,
})

export const archiveChatSession = withSync(rawChatSession.archive, {
  table: 'chat_sessions',
  op: 'update',
  extractRow: ({ args }) =>
    rawChatSession.getSession(args[0]) as unknown as Record<string, unknown> | null,
})

export const setChatSessionCacheEnabled = withSync(
  rawChatSession.setCacheEnabled,
  {
    table: 'chat_sessions',
    op: 'update',
    extractRow: ({ args }) =>
      rawChatSession.getSession(args[0]) as unknown as Record<string, unknown> | null,
  },
)

export const deleteChatSession = withSync(rawChatSession.deleteSession, {
  table: 'chat_sessions',
  op: 'delete',
  captureBeforeDelete: (_db, [sessionId]) =>
    rawChatSession.getSession(sessionId) as unknown as Record<string, unknown> | null,
})

// Pass-throughs (reads)
export const getActiveChatSessionForContext = rawChatSession.getActiveForContext
export const getChatSession = rawChatSession.getSession
export const listRecentChatSessions = rawChatSession.listRecent
export const loadChatMessages = rawChatSession.loadMessages
export const searchChatSessions = rawChatSession.search
export const getChatMessageCount = rawChatSession.getMessageCount

// ── investment memos (2026-05-23) ───────────────────────────────────────────
//
// Added to unblock the mobile Memos tab on company detail. Desktop is the
// only writer; mobile reads via the gateway /memos route. The barrel wraps
// the three write entry points so memo writes flow to Neon via the outbox.
//
// Cascade pattern: saveMemoVersion does an INSERT on investment_memo_versions
// AND an UPDATE on investment_memos (bumping latest_version_number). The
// wrapper emits ONE outbox row (the version insert); the raw repo emits a
// second outbox row for the parent memo update inside the same transaction
// (see appendOutboxRow call in investment-memo.repo.ts). Same pattern as
// note_folders cascade-deletes.
//
// extractRow on inserts/updates re-SELECTs the full SQLite row (snake_case,
// includes lamport + created_by_user_id) because the raw fn returns a
// partial camelCase DTO. The gateway's snakeToCamel bridge expects the
// snake_case payload that SELECT * produces.

function selectMemoRow(memoId: string): Record<string, unknown> | null {
  return getDatabase()
    .prepare('SELECT * FROM investment_memos WHERE id = ?')
    .get(memoId) as Record<string, unknown> | null
}
function selectMemoVersionRow(versionId: string): Record<string, unknown> | null {
  return getDatabase()
    .prepare('SELECT * FROM investment_memo_versions WHERE id = ?')
    .get(versionId) as Record<string, unknown> | null
}

export const createMemo = withSync(rawMemo.createMemo, {
  table: 'investment_memos',
  op: 'insert',
  extractRow: ({ result }) => {
    const r = result as { id: string } | null
    return r ? selectMemoRow(r.id) : null
  },
})

export const updateMemoStatus = withSync(rawMemo.updateMemoStatus, {
  table: 'investment_memos',
  op: 'update',
  extractRow: ({ args }) => selectMemoRow(args[0]),
})

export const saveMemoVersion = withSync(rawMemo.saveMemoVersion, {
  table: 'investment_memo_versions',
  op: 'insert',
  extractRow: ({ result }) => {
    const r = result as { id: string } | null
    return r ? selectMemoVersionRow(r.id) : null
  },
})

// getOrCreateMemoForCompany — composite of (find OR (createMemo + saveMemoVersion)).
// Reimplemented here so the inner calls use the WRAPPED versions above and
// therefore reach Neon. The raw version in the repo calls raw createMemo +
// raw saveMemoVersion, which would bypass the outbox.
export function getOrCreateMemoForCompany(
  companyId: string,
  companyName: string,
  userId: string | null = null,
): InvestmentMemoWithLatest {
  const existing = rawMemo.getLatestMemoForCompany(companyId)
  if (existing) return existing

  const memo = createMemo(
    { companyId, title: `${companyName} Investment Memo` },
    userId,
  )
  const initialContent = rawMemo.buildInitialMemoContent(companyName)
  const version = saveMemoVersion(
    memo.id,
    { contentMarkdown: initialContent, changeNote: 'Initial draft' },
    userId,
  )
  return { ...memo, latestVersion: version, latestVersionNumber: version.versionNumber }
}

// Pass-throughs (reads + non-owned-table writes)
export const getMemo = rawMemo.getMemo
export const getLatestMemoForCompany = rawMemo.getLatestMemoForCompany
export const listMemoVersions = rawMemo.listMemoVersions
export const listMemoVersionsSummary = rawMemo.listMemoVersionsSummary
export const getMemoLatestVersion = rawMemo.getMemoLatestVersion
export const getMemoVersion = rawMemo.getMemoVersion
// recordMemoExport writes investment_memo_exports — NOT in OWNED_TABLES
// (exports are local artifacts; mobile doesn't read them). Pass-through.
export const recordMemoExport = rawMemo.recordMemoExport

// ── company_flagged_files (Phase 3) ─────────────────────────────────────────
//
// Pre-Phase-3, the raw repo's `toggleFileFlag` wrote directly without
// `withSync`, so flags never reached Neon — mobile chat couldn't see them.
// Phase 3 splits the toggle into explicit `flagFile` / `unflagFile` /
// `refreshFlaggedFile` / `updateFlaggedFileExtraction` verbs and wraps each.
// `extractedText` is declared as a largeColumn on the OwnedTableSpec, so
// status-only updates (pending → extracting) don't drag the file body across
// the wire each time (T38 trim-on-update).
//
// The extraction worker (src/main/services/flagged-file-extraction-worker.ts)
// calls `updateFlaggedFileExtraction` for each state transition; flag UI
// calls `flagFile` / `unflagFile` / `refreshFlaggedFile`.

export const flagFile = withSync(rawFlaggedFiles.flagFile, {
  table: 'company_flagged_files',
  op: 'insert',
})

export const unflagFile = withSync(rawFlaggedFiles.unflagFile, {
  table: 'company_flagged_files',
  op: 'delete',
  captureBeforeDelete: (_db, [args]) =>
    rawFlaggedFiles.getFlaggedFileByPair(args.companyId, args.fileId) as unknown as
      | Record<string, unknown>
      | null,
})

export const refreshFlaggedFile = withSync(rawFlaggedFiles.refreshFlaggedFile, {
  table: 'company_flagged_files',
  op: 'update',
  captureBeforeUpdate: (_db, [args]) =>
    rawFlaggedFiles.getFlaggedFileByPair(args.companyId, args.fileId) as unknown as
      | Record<string, unknown>
      | null,
})

export const updateFlaggedFileExtraction = withSync(
  rawFlaggedFiles.updateFlaggedFileExtraction,
  {
    table: 'company_flagged_files',
    op: 'update',
    captureBeforeUpdate: (_db, [id]) =>
      rawFlaggedFiles.getFlaggedFileById(id) as unknown as
        | Record<string, unknown>
        | null,
  },
)

// Pass-throughs (reads + helpers used by chat-context formatter, capability flow).
export const getFlaggedFiles = rawFlaggedFiles.getFlaggedFiles
export const getFlaggedFilesDetailed = rawFlaggedFiles.getFlaggedFilesDetailed
export const getFlaggedFileIds = rawFlaggedFiles.getFlaggedFileIds
export const isFlaggedAnywhere = rawFlaggedFiles.isFlaggedAnywhere
export const isFlaggedForCompany = rawFlaggedFiles.isFlaggedForCompany
export const getFlaggedFileById = rawFlaggedFiles.getFlaggedFileById
export const getFlaggedFileByPair = rawFlaggedFiles.getFlaggedFileByPair
export const getPendingExtractionRows = rawFlaggedFiles.getPendingExtractionRows
export type {
  FlaggedFile,
  FlaggedFileRow,
  FlagFileArgs,
  UnflagFileArgs,
  RefreshFlaggedFileArgs,
  UpdateFlaggedFileExtractionPatch,
} from './company-file-flags.repo'

// Re-export the database accessor so the rare caller that needs it can
// continue to import from the barrel rather than reaching into connection.ts.
export { getDatabase }
