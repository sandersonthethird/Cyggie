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
})

export const deleteMeeting = withSync(rawMeeting.deleteMeeting, {
  table: 'meetings',
  op: 'delete',
  captureBeforeDelete: (_db, [id]) =>
    rawMeeting.getMeeting(id) as unknown as Record<string, unknown> | null,
})

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

// contact_emails is a composite-PK table (contact_id, email). addContactEmail
// inserts; the wrapper looks up the table spec from OWNED_TABLES_BY_NAME and
// encodes both columns into outbox.row_id.
export const addContactEmail = withSync(rawContact.addContactEmail, {
  table: 'contact_emails',
  op: 'insert',
})

export const updateContactEmail = withSync(rawContact.updateContactEmail, {
  table: 'contact_emails',
  op: 'update',
})

export const removeContactEmail = withSync(rawContact.removeContactEmail, {
  table: 'contact_emails',
  op: 'delete',
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
export const autoLinkContactsByDomain = rawContact.autoLinkContactsByDomain
export const syncContactsFromAttendees = rawContact.syncContactsFromAttendees
export const syncContactsFromMeetings = rawContact.syncContactsFromMeetings
export const enrichExistingContacts = rawContact.enrichExistingContacts
export const enrichContact = rawContact.enrichContact
export const enrichContactsByIds = rawContact.enrichContactsByIds
export const listPastEmployeeContacts = rawContact.listPastEmployeeContacts
export const resolveContactsByEmails = rawContact.resolveContactsByEmails
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

// Pass-throughs (reads + folder operations with multi-row cascades — see gap)
export const listNotes = rawNotes.listNotes
export const searchNotes = rawNotes.searchNotes
export const getNote = rawNotes.getNote
export const listFolders = rawNotes.listFolders
export const renameFolder = rawNotes.renameFolder // updates many notes' folder_path — un-emitted in V1
export const deleteFolder = rawNotes.deleteFolder // ditto
export const getFolderCounts = rawNotes.getFolderCounts
export const listImportSources = rawNotes.listImportSources

// Re-export the database accessor so the rare caller that needs it can
// continue to import from the barrel rather than reaching into connection.ts.
export { getDatabase }
