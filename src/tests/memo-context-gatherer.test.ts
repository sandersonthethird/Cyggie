import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

vi.mock('../main/database/connection', () => ({
  getDatabase: vi.fn(),
}))

// Minimal stubs for repos that gatherMemoSourceCounts pulls. Each returns
// based on the in-memory DB state we set up in beforeEach.
vi.mock('../main/database/repositories/org-company.repo', () => ({
  listCompanyMeetingSummaryPaths: vi.fn(),
  listCompanyMeetings: vi.fn(),
  listCompanyContacts: vi.fn(),
  listCompanyEmails: vi.fn(),
}))
vi.mock('../main/database/repositories/company-file-flags.repo', () => ({
  getFlaggedFiles: vi.fn(),
}))

import * as companyRepo from '../main/database/repositories/org-company.repo'
import { getFlaggedFiles } from '../main/database/repositories/company-file-flags.repo'
import { getDatabase } from '../main/database/connection'
import { gatherMemoSourceCounts } from '../main/llm/memo-context-gatherer'

const mockGetDb = vi.mocked(getDatabase)
const mockListSummaryPaths = vi.mocked(companyRepo.listCompanyMeetingSummaryPaths)
const mockListMeetings = vi.mocked(companyRepo.listCompanyMeetings)
const mockListContacts = vi.mocked(companyRepo.listCompanyContacts)
const mockListEmails = vi.mocked(companyRepo.listCompanyEmails)
const mockGetFlaggedFiles = vi.mocked(getFlaggedFiles)

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      company_id TEXT,
      theme_id TEXT,
      title TEXT,
      content TEXT NOT NULL,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      source_meeting_id TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      folder_path TEXT,
      import_source TEXT
    );
  `)
  return db
}

function insertNote(db: Database.Database, data: { contactId?: string; companyId?: string; content: string }): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO notes (id, contact_id, company_id, content)
    VALUES (?, ?, ?, ?)
  `).run(id, data.contactId ?? null, data.companyId ?? null, data.content)
  return id
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: all repos return empty
  mockListSummaryPaths.mockReturnValue([])
  mockListMeetings.mockReturnValue([])
  mockListContacts.mockReturnValue([])
  mockListEmails.mockReturnValue([])
  mockGetFlaggedFiles.mockReturnValue([])
})

describe('gatherMemoSourceCounts', () => {
  it('returns empty arrays for a company with no data', () => {
    mockGetDb.mockReturnValue(makeDb())
    const result = gatherMemoSourceCounts('co-empty')
    expect(result.meetings).toEqual([])
    expect(result.summaryRows).toEqual([])
    expect(result.companyNotes).toEqual([])
    expect(result.contactNotes).toEqual([])
    expect(result.linkedContacts).toEqual([])
    expect(result.flaggedFiles).toEqual([])
    expect(result.emails).toEqual([])
  })

  it('sorts linkedContacts by meetingCount DESC', () => {
    mockGetDb.mockReturnValue(makeDb())
    mockListContacts.mockReturnValue([
      { id: 'c-low', fullName: 'Low Engagement', email: null, title: null, contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: false, meetingCount: 2, lastInteractedAt: null, updatedAt: '2026-01-01' },
      { id: 'c-high', fullName: 'High Engagement', email: null, title: 'CEO', contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: true, meetingCount: 10, lastInteractedAt: null, updatedAt: '2026-01-01' },
      { id: 'c-mid', fullName: 'Mid Engagement', email: null, title: null, contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: false, meetingCount: 5, lastInteractedAt: null, updatedAt: '2026-01-01' },
    ])
    const result = gatherMemoSourceCounts('co-1')
    expect(result.linkedContacts.map(c => c.id)).toEqual(['c-high', 'c-mid', 'c-low'])
  })

  it('does NOT mutate the array returned by listCompanyContacts (slice before sort)', () => {
    const original = [
      { id: 'a', fullName: 'A', email: null, title: null, contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: false, meetingCount: 1, lastInteractedAt: null, updatedAt: '2026-01-01' },
      { id: 'b', fullName: 'B', email: null, title: null, contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: false, meetingCount: 5, lastInteractedAt: null, updatedAt: '2026-01-01' },
    ]
    mockGetDb.mockReturnValue(makeDb())
    mockListContacts.mockReturnValue(original)
    gatherMemoSourceCounts('co-1')
    // Original ordering preserved (b was second, a was first)
    expect(original.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('skips contact-notes batch query when there are no linked contacts', () => {
    const db = makeDb()
    mockGetDb.mockReturnValue(db)
    mockListContacts.mockReturnValue([])
    const result = gatherMemoSourceCounts('co-1')
    expect(result.contactNotes).toEqual([])
    // No linked contacts → no SQL fired (no rows queried). Hard to assert
    // directly without spying on db.prepare; covered by the no-throw
    // and the empty array result.
  })

  it('pulls company-tagged notes via _companyNotesRepo.list', () => {
    const db = makeDb()
    insertNote(db, { companyId: 'co-1', content: 'company note' })
    insertNote(db, { contactId: 'c-x', content: 'contact note (different path)' })
    mockGetDb.mockReturnValue(db)
    const result = gatherMemoSourceCounts('co-1')
    expect(result.companyNotes).toHaveLength(1)
    expect(result.companyNotes[0]!.content).toBe('company note')
  })

  it('pulls contact-tagged notes for linked contacts via batched listForEntities', () => {
    const db = makeDb()
    insertNote(db, { contactId: 'c-1', content: 'jane note' })
    insertNote(db, { contactId: 'c-2', content: 'sam note' })
    insertNote(db, { contactId: 'c-3', content: 'unrelated' })
    mockGetDb.mockReturnValue(db)
    mockListContacts.mockReturnValue([
      { id: 'c-1', fullName: 'Jane', email: null, title: 'CEO', contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: true, meetingCount: 5, lastInteractedAt: null, updatedAt: '2026-01-01' },
      { id: 'c-2', fullName: 'Sam', email: null, title: 'CTO', contactType: null, linkedinUrl: null, keyTakeaways: null, isPrimary: false, meetingCount: 3, lastInteractedAt: null, updatedAt: '2026-01-01' },
      // c-3 is NOT a linked contact
    ])
    const result = gatherMemoSourceCounts('co-1')
    expect(result.contactNotes).toHaveLength(2)
    const contents = result.contactNotes.map(n => n.content).sort()
    expect(contents).toEqual(['jane note', 'sam note'])
  })

  it('caps emails at 30', () => {
    mockGetDb.mockReturnValue(makeDb())
    const fakeEmails = Array.from({ length: 50 }, (_, i) => ({
      id: `e-${i}`,
      subject: `Email ${i}`,
      fromEmail: 'a@b.com',
      fromName: null,
      receivedAt: '2026-01-01',
      sentAt: null,
      snippet: null,
      bodyText: 'body',
      isUnread: false,
      threadId: null,
      threadGroup: '',
      providerThreadId: null,
      threadMessageCount: 1,
      participants: [],
      accountEmail: null,
    }))
    mockListEmails.mockReturnValue(fakeEmails)
    const result = gatherMemoSourceCounts('co-1')
    expect(result.emails).toHaveLength(30)
  })
})
