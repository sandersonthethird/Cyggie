import * as companyRepo from '../database/repositories/org-company.repo'
import { makeEntityNotesRepo } from '../database/repositories/notes-base'
import { getFlaggedFiles, type FlaggedFile } from '../database/repositories/company-file-flags.repo'
import type { CompanyContactRef, CompanyEmailRef, CompanyMeetingRef } from '../../shared/types/company'
import type { Note } from '../../shared/types/note'

/**
 * Single source of truth for the source-count gathering used by both
 * INVESTMENT_MEMO_GENERATE and INVESTMENT_MEMO_PREFLIGHT.
 *
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │  Why?                                                            │
 *   │  Without this helper, the preflight handler runs the same SQL    │
 *   │  passes (notes, contacts, emails, files, meetings) that the      │
 *   │  generate handler runs ~1s later. Two passes per warning-        │
 *   │  triggering Generate. ~50ms wasted, but the real cost is DRY     │
 *   │  drift the next time someone adds a source.                      │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * Both callers pull from the SAME tables. This helper pulls them once and
 * returns the raw rows; each caller derives the bits it cares about
 * (preflight: counts; generate: row content).
 *
 * NO file reads here — `flaggedFiles` is metadata only. File content
 * extraction happens in the GENERATE handler's file-read loop, which is
 * Cancel-aware (between-iteration `signal.aborted` check).
 */

const _companyNotesRepo = makeEntityNotesRepo('company_id')
const _contactNotesRepo = makeEntityNotesRepo('contact_id')

export interface MemoSourceCounts {
  meetings: CompanyMeetingRef[]
  /** Subset of `meetings` that have an AI summary loaded (rows from `listCompanyMeetingSummaryPaths`). */
  summaryRows: Array<{ meetingId: string; title: string; date: string; summaryPath: string }>
  /** `_companyNotesRepo.list(companyId)`. */
  companyNotes: Note[]
  /** Notes tagged to any of the linked contacts (single batched query via listForEntities). */
  contactNotes: Note[]
  /** Sorted by meetingCount DESC for downstream founder-id + key-takeaways logic. */
  linkedContacts: CompanyContactRef[]
  flaggedFiles: FlaggedFile[]
  emails: CompanyEmailRef[]
}

/**
 * Pull all the source data the memo-gen pipeline cares about. Cheap (~30-50ms
 * for typical companies). NO file reads.
 */
export function gatherMemoSourceCounts(companyId: string): MemoSourceCounts {
  const summaryRows = companyRepo.listCompanyMeetingSummaryPaths(companyId)
  const meetings = companyRepo.listCompanyMeetings(companyId)
  const companyNotes = _companyNotesRepo.list(companyId)
  const linkedContacts = companyRepo
    .listCompanyContacts(companyId)
    .slice()
    .sort((a, b) => (b.meetingCount ?? 0) - (a.meetingCount ?? 0))
  const contactIds = linkedContacts.map(c => c.id)
  const contactNotes = contactIds.length > 0 ? _contactNotesRepo.listForEntities(contactIds) : []
  const flaggedFiles = getFlaggedFiles(companyId)
  const emails = companyRepo.listCompanyEmails(companyId).slice(0, 30)

  return { meetings, summaryRows, companyNotes, contactNotes, linkedContacts, flaggedFiles, emails }
}
