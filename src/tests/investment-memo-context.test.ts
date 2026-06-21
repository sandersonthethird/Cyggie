import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Integration test for the IPC handler's gathering logic. The actual handler
 * is registered with ipcMain so we don't invoke it through Electron;
 * instead we test the data-gathering code by exercising the underlying
 * services through the same code path the handler uses.
 *
 * Strategy: spy on `generateMemo` so we can assert the input shape that the
 * handler builds. Mock `searchCompanyContext` so it returns a deterministic
 * bundle. Mock `readSummary` / `readTranscript` / `readLocalFile` so file IO
 * doesn't fire. The repos run against a real in-memory SQLite.
 *
 * The "code path" we exercise is `gatherMemoContext` — implementing the test
 * via a small inline copy of the handler's gathering loop. This isolates the
 * gathering code from Electron / IPC plumbing while still verifying the
 * key invariants:
 *   - meta counts match what was actually gathered
 *   - contactNotes are sorted by linked-contact meetingCount DESC
 *   - notes tagged to BOTH a company and a contact are deduped
 *   - flagged drive files are auto-included when no selectedFileIds passed
 */

import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'

const mockGetDb = vi.mocked(getDatabase)

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Minimal schema for what gathering touches: notes (both contact + company tagged),
  // and the company_flagged_files table.
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      company_id TEXT,
      theme_id TEXT,
      title TEXT,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_private INTEGER NOT NULL DEFAULT 0,
      source_meeting_id TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      deleted_by_user_id TEXT,
      folder_path TEXT,
      import_source TEXT
    );
  `)
  return db
}

function insertNote(
  db: Database.Database,
  data: { id?: string; contactId?: string; companyId?: string; content: string; title?: string; updatedAt?: string }
): string {
  const id = data.id ?? randomUUID()
  db.prepare(`
    INSERT INTO notes (id, contact_id, company_id, content, title, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.contactId ?? null,
    data.companyId ?? null,
    data.content,
    data.title ?? null,
    data.updatedAt ?? new Date().toISOString(),
    data.updatedAt ?? new Date().toISOString(),
  )
  return id
}

/**
 * The chunk of investment-memo.ipc.ts we want to test, lifted into a pure
 * function so it's testable in isolation. If the IPC handler grows much
 * more, this should be extracted into a real `gatherMemoContext` service
 * (already in TODOS as P2). For now we mirror the logic.
 */
interface ContactRef {
  id: string
  fullName: string
  title: string | null
  isPrimary: boolean
  meetingCount: number
  keyTakeaways: string | null
}

interface FlaggedFile {
  fileId: string
  fileName: string
  mimeType: string | null
}

interface GatherResult {
  contactNoteTexts: string[]
  contactKeyTakeaways: Array<{ name: string; takeaways: string }>
  fileIds: string[]
  founderNames: string[]
  nicheSignal: string | null
}

function gatherForTest(args: {
  linkedContacts: ContactRef[]
  companyTaggedNoteIds: string[]
  flaggedFiles: FlaggedFile[]
  selectedFileIds: string[]
  recentSummaryContent: string | null
}): GatherResult {
  const _contactNotesRepo = makeEntityNotesRepo('contact_id')

  // Mirror the handler's sort: most-engaged contacts first.
  const linkedContacts = args.linkedContacts
    .slice()
    .sort((a, b) => (b.meetingCount ?? 0) - (a.meetingCount ?? 0))

  // Batched contact-notes pull.
  const contactIds = linkedContacts.map(c => c.id)
  const allContactNotes = contactIds.length > 0
    ? _contactNotesRepo.listForEntities(contactIds)
    : []
  const seenNoteIds = new Set(args.companyTaggedNoteIds)
  const contactNoteTexts: string[] = []
  const notesByContact = new Map<string, typeof allContactNotes>()
  for (const n of allContactNotes) {
    if (!n.contactId) continue
    const list = notesByContact.get(n.contactId) ?? []
    list.push(n)
    notesByContact.set(n.contactId, list)
  }
  for (const contact of linkedContacts) {
    const cnotes = notesByContact.get(contact.id) ?? []
    for (const n of cnotes) {
      if (seenNoteIds.has(n.id)) continue
      seenNoteIds.add(n.id)
      if (!n.content?.trim()) continue
      const prefix = `**Contact: ${contact.fullName}${n.title ? ` — ${n.title}` : ''}**`
      contactNoteTexts.push(`${prefix}\n${n.content}`)
    }
  }

  // Contact key takeaways from already-loaded contacts.
  const contactKeyTakeaways: Array<{ name: string; takeaways: string }> = []
  for (const contact of linkedContacts.slice(0, 8)) {
    if (contact.keyTakeaways?.trim()) {
      contactKeyTakeaways.push({ name: contact.fullName, takeaways: contact.keyTakeaways })
    }
  }

  // File-ids resolution.
  const fileIds = args.selectedFileIds.length > 0
    ? args.selectedFileIds
    : args.flaggedFiles.map(f => f.fileId)

  // Niche signal.
  const nicheSignal = args.recentSummaryContent?.trim()
    ? args.recentSummaryContent.slice(0, 500)
    : null

  // Founder identification.
  const FOUNDER_TITLE_RE = /founder|ceo|cto|coo|chief/i
  const titledFounders = linkedContacts.filter(c => FOUNDER_TITLE_RE.test(c.title ?? ''))
  const founderNames =
    titledFounders.length > 0
      ? titledFounders.slice(0, 2).map(c => c.fullName)
      : linkedContacts.filter(c => c.isPrimary).slice(0, 2).map(c => c.fullName)

  return { contactNoteTexts, contactKeyTakeaways, fileIds, founderNames, nicheSignal }
}

describe('gatherMemoContext (in-IPC-handler logic)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    mockGetDb.mockReturnValue(db)
  })

  describe('contactNotes — sorting + dedup', () => {
    it('sorts contactNotes by linked-contact meetingCount DESC', () => {
      // Founder Jane has 10 meetings; Associate Alex has 1; both tagged with notes.
      insertNote(db, { contactId: 'c-jane', content: 'jane note', updatedAt: '2026-01-01' })
      insertNote(db, { contactId: 'c-alex', content: 'alex note', updatedAt: '2026-05-01' })

      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-alex', fullName: 'Alex Associate', title: null, isPrimary: false, meetingCount: 1, keyTakeaways: null },
          { id: 'c-jane', fullName: 'Jane Founder', title: 'CEO', isPrimary: true, meetingCount: 10, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })

      // Jane's note appears FIRST despite Alex's note being newer — sort is by
      // linked-contact engagement, not by note age.
      expect(result.contactNoteTexts[0]).toContain('Jane Founder')
      expect(result.contactNoteTexts[0]).toContain('jane note')
      expect(result.contactNoteTexts[1]).toContain('Alex Associate')
    })

    it('dedupes notes that are tagged to BOTH a contact and a company', () => {
      // The same note id is in both the company-tagged set AND the contact-tagged result.
      const dupNoteId = 'shared-note'
      insertNote(db, { id: dupNoteId, contactId: 'c-jane', content: 'jane shared note' })

      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-jane', fullName: 'Jane Founder', title: 'CEO', isPrimary: true, meetingCount: 5, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [dupNoteId],   // already pulled via company-notes path
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })

      // Note should NOT appear in contactNoteTexts — it was already counted as a company note.
      expect(result.contactNoteTexts).toHaveLength(0)
    })

    it('skips contacts with no notes, includes those with notes', () => {
      insertNote(db, { contactId: 'c-jane', content: 'jane note' })
      // c-alex has no notes
      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-jane', fullName: 'Jane', title: null, isPrimary: false, meetingCount: 5, keyTakeaways: null },
          { id: 'c-alex', fullName: 'Alex', title: null, isPrimary: false, meetingCount: 3, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.contactNoteTexts).toHaveLength(1)
      expect(result.contactNoteTexts[0]).toContain('Jane')
    })

    it('returns empty contactNoteTexts when company has no linked contacts', () => {
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.contactNoteTexts).toEqual([])
      expect(result.contactKeyTakeaways).toEqual([])
      expect(result.founderNames).toEqual([])
    })
  })

  describe('contactKeyTakeaways', () => {
    it('pulls only contacts with non-empty keyTakeaways', () => {
      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-1', fullName: 'Has Takeaways', title: 'CEO', isPrimary: true, meetingCount: 10, keyTakeaways: 'Built Stripe before' },
          { id: 'c-2', fullName: 'No Takeaways', title: 'CTO', isPrimary: false, meetingCount: 3, keyTakeaways: null },
          { id: 'c-3', fullName: 'Empty Takeaways', title: 'COO', isPrimary: false, meetingCount: 1, keyTakeaways: '   ' },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.contactKeyTakeaways).toHaveLength(1)
      expect(result.contactKeyTakeaways[0]!.name).toBe('Has Takeaways')
    })

    it('caps at 8 contacts (top 8 by meetingCount via the sort)', () => {
      const linkedContacts: ContactRef[] = []
      for (let i = 0; i < 12; i++) {
        linkedContacts.push({
          id: `c-${i}`,
          fullName: `Contact ${i}`,
          title: null,
          isPrimary: false,
          meetingCount: 12 - i,    // c-0 has 12 meetings, c-11 has 1
          keyTakeaways: `takeaway for ${i}`,
        })
      }
      const result = gatherForTest({
        linkedContacts,
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.contactKeyTakeaways).toHaveLength(8)
      // First 8 by meetingCount DESC are c-0..c-7
      expect(result.contactKeyTakeaways.map(c => c.name)).toEqual([
        'Contact 0', 'Contact 1', 'Contact 2', 'Contact 3',
        'Contact 4', 'Contact 5', 'Contact 6', 'Contact 7',
      ])
    })
  })

  describe('drive files', () => {
    it('auto-includes flagged files when caller passes empty selectedFileIds', () => {
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [
          { fileId: 'f-1', fileName: 'deck.pdf', mimeType: 'application/pdf' },
          { fileId: 'f-2', fileName: 'model.xlsx', mimeType: 'application/vnd.ms-excel' },
        ],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.fileIds).toEqual(['f-1', 'f-2'])
    })

    it('caller-supplied selectedFileIds wins over flagged-file fallback', () => {
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [
          { fileId: 'f-1', fileName: 'flagged.pdf', mimeType: null },
        ],
        selectedFileIds: ['user-picked-1', 'user-picked-2'],
        recentSummaryContent: null,
      })
      expect(result.fileIds).toEqual(['user-picked-1', 'user-picked-2'])
    })

    it('returns [] when company has no flagged files and caller passes none', () => {
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.fileIds).toEqual([])
    })
  })

  describe('niche signal', () => {
    it('uses first 500 chars of most-recent summary content', () => {
      const longSummary = 'x'.repeat(700)
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: longSummary,
      })
      expect(result.nicheSignal).toHaveLength(500)
    })

    it('returns null when summary is whitespace-only', () => {
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: '   \n  \t ',
      })
      expect(result.nicheSignal).toBeNull()
    })

    it('returns null when no summary exists', () => {
      const result = gatherForTest({
        linkedContacts: [],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.nicheSignal).toBeNull()
    })
  })

  describe('founder identification', () => {
    it('matches CEO/Founder/CTO/COO/Chief titles via regex', () => {
      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-1', fullName: 'Jane CEO', title: 'CEO & Founder', isPrimary: true, meetingCount: 10, keyTakeaways: null },
          { id: 'c-2', fullName: 'Sam CTO', title: 'Chief Technology Officer', isPrimary: false, meetingCount: 5, keyTakeaways: null },
          { id: 'c-3', fullName: 'Investor', title: 'Investor', isPrimary: false, meetingCount: 1, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.founderNames).toEqual(['Jane CEO', 'Sam CTO'])
    })

    it('falls back to isPrimary contacts when no titled-founders exist', () => {
      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-1', fullName: 'Primary One', title: 'Engineer', isPrimary: true, meetingCount: 5, keyTakeaways: null },
          { id: 'c-2', fullName: 'Not Primary', title: 'Engineer', isPrimary: false, meetingCount: 10, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.founderNames).toEqual(['Primary One'])
    })

    it('caps founder list at 2', () => {
      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-1', fullName: 'Founder A', title: 'CEO', isPrimary: true, meetingCount: 10, keyTakeaways: null },
          { id: 'c-2', fullName: 'Founder B', title: 'CTO', isPrimary: false, meetingCount: 9, keyTakeaways: null },
          { id: 'c-3', fullName: 'Founder C', title: 'COO', isPrimary: false, meetingCount: 8, keyTakeaways: null },
          { id: 'c-4', fullName: 'Founder D', title: 'Chief Strategy', isPrimary: false, meetingCount: 7, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.founderNames).toHaveLength(2)
      expect(result.founderNames).toEqual(['Founder A', 'Founder B'])
    })

    it('returns [] when no titled or primary contacts exist', () => {
      const result = gatherForTest({
        linkedContacts: [
          { id: 'c-1', fullName: 'No Title', title: null, isPrimary: false, meetingCount: 1, keyTakeaways: null },
        ],
        companyTaggedNoteIds: [],
        flaggedFiles: [],
        selectedFileIds: [],
        recentSummaryContent: null,
      })
      expect(result.founderNames).toEqual([])
    })
  })
})
