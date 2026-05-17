/**
 * Tests for createMeetingCompanionNote() in note-companion-backfill.service.ts
 *
 * Branches covered (from the production code):
 *
 *   Input: { entityType, entityId, sourceMeetingId, ... }
 *                       │
 *                       ▼
 *      existing = SELECT … FROM notes WHERE source_meeting_id = ?
 *                       │
 *           ┌───────────┴───────────┐
 *           │                       │
 *      existing found          no existing
 *           │                       │
 *    ┌──────┼──────┐                │
 *    │      │      │                ▼
 *  same  NULL   diff           repo.create(…)
 *  entity entity entity        (test 1, 2)
 *    │      │      │
 *    ▼      ▼      ▼
 *  return  UPDATE  fall through
 *  as-is  +return  → repo.create
 *  (test 3)(test 4) (test 5)
 *
 * Race-recovery catch branch (UNIQUE collision after a parallel insert)
 * is defensive code; not unit-testable without internal mocking, so it's
 * documented here as an intentional coverage gap.
 *
 * Mock boundaries:
 *   - database/connection.getDatabase → real in-memory SQLite via buildTestDbFull
 *   - everything else (notes-base, file-manager, org-company.repo) → REAL,
 *     so the SQL paths + FK + UNIQUE constraints actually fire
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { buildTestDbFull } from './_fixtures/test-db'

// ─── Mocks ───────────────────────────────────────────────────────────────────

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

// listCompanyMeetingSummaryPaths is imported by the same module but not used
// by createMeetingCompanionNote itself — stub it cheaply.
vi.mock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
  listCompanyMeetingSummaryPaths: vi.fn(() => []),
}))

// readSummary likewise imported but not called by createMeetingCompanionNote.
vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn(),
}))

// ─── Import after mocks ──────────────────────────────────────────────────────

const { createMeetingCompanionNote } = await import(
  '../main/services/note-companion-backfill.service'
)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function seedCompany(id: string, name: string): void {
  testDb
    .prepare(
      `INSERT INTO org_companies (id, canonical_name, normalized_name, entity_type, classification_source)
       VALUES (?, ?, ?, 'prospect', 'manual')`,
    )
    .run(id, name, name.toLowerCase().replace(/\s+/g, ''))
}

function seedContact(id: string, fullName: string): void {
  testDb
    .prepare(
      `INSERT INTO contacts (id, full_name, normalized_name)
       VALUES (?, ?, ?)`,
    )
    .run(id, fullName, fullName.toLowerCase().replace(/\s+/g, ''))
}

function seedMeeting(id: string, title = 'Test Meeting'): void {
  testDb
    .prepare(`INSERT INTO meetings (id, title, date) VALUES (?, ?, '2026-01-01')`)
    .run(id, title)
}

function countNotesFor(entityCol: 'company_id' | 'contact_id', entityId: string): number {
  const row = testDb
    .prepare(`SELECT COUNT(*) AS n FROM notes WHERE ${entityCol} = ?`)
    .get(entityId) as { n: number }
  return row.n
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createMeetingCompanionNote', () => {
  beforeEach(() => {
    testDb = buildTestDbFull()
  })

  it('creates a fresh companion note for a company when no prior note exists', () => {
    seedCompany('co-1', 'Acme Corp')
    seedMeeting('m-1')

    const note = createMeetingCompanionNote({
      entityType: 'company',
      entityId: 'co-1',
      content: '## Meeting summary\n\nNotes from the call.',
      sourceMeetingId: 'm-1',
    })

    expect(note).not.toBeNull()
    expect(note!.companyId).toBe('co-1')
    expect(note!.contactId).toBeNull()
    expect(note!.sourceMeetingId).toBe('m-1')
    expect(note!.content).toContain('Meeting summary')
    expect(countNotesFor('company_id', 'co-1')).toBe(1)
  })

  it('creates a fresh companion note for a contact when no prior note exists', () => {
    seedContact('c-1', 'Alice Example')
    seedMeeting('m-2')

    const note = createMeetingCompanionNote({
      entityType: 'contact',
      entityId: 'c-1',
      content: 'Notes',
      sourceMeetingId: 'm-2',
    })

    expect(note).not.toBeNull()
    expect(note!.contactId).toBe('c-1')
    expect(note!.companyId).toBeNull()
    expect(note!.sourceMeetingId).toBe('m-2')
    expect(countNotesFor('contact_id', 'c-1')).toBe(1)
  })

  it('returns the existing note when the same entity is already tagged for that meeting', () => {
    seedCompany('co-1', 'Acme Corp')
    seedMeeting('m-3')

    const first = createMeetingCompanionNote({
      entityType: 'company',
      entityId: 'co-1',
      content: 'First content',
      sourceMeetingId: 'm-3',
    })
    expect(first).not.toBeNull()

    const second = createMeetingCompanionNote({
      entityType: 'company',
      entityId: 'co-1',
      content: 'Second content — should be ignored, existing note returned as-is',
      sourceMeetingId: 'm-3',
    })

    expect(second).not.toBeNull()
    expect(second!.id).toBe(first!.id)
    // Idempotent: only one row exists for this entity+meeting tuple.
    expect(countNotesFor('company_id', 'co-1')).toBe(1)
    // Content was NOT overwritten — the existing note is returned as-is.
    expect(second!.content).toBe('First content')
  })

  it('claims an orphan companion note (entity_id IS NULL) by setting the FK', () => {
    seedCompany('co-1', 'Acme Corp')
    seedMeeting('m-4')

    // Pre-seed an orphan note: source_meeting_id set, company_id NULL.
    testDb
      .prepare(
        `INSERT INTO notes (id, company_id, content, source_meeting_id, created_at, updated_at)
         VALUES ('orphan-1', NULL, 'orphan content', 'm-4', datetime('now'), datetime('now'))`,
      )
      .run()

    const claimed = createMeetingCompanionNote({
      entityType: 'company',
      entityId: 'co-1',
      content: 'this is ignored because the orphan is claimed as-is',
      sourceMeetingId: 'm-4',
    })

    expect(claimed).not.toBeNull()
    expect(claimed!.id).toBe('orphan-1')
    expect(claimed!.companyId).toBe('co-1')
    // Still only one row — the orphan was updated, not duplicated.
    expect(countNotesFor('company_id', 'co-1')).toBe(1)
    // Original content preserved.
    expect(claimed!.content).toBe('orphan content')
  })

  it('creates a separate note when source_meeting_id matches a DIFFERENT entity (multi-entity meeting)', () => {
    seedCompany('co-A', 'Alpha')
    seedCompany('co-B', 'Beta')
    seedMeeting('m-5')

    // Pre-seed a note tagged to co-A for meeting m-5.
    const firstA = createMeetingCompanionNote({
      entityType: 'company',
      entityId: 'co-A',
      content: 'Alpha note',
      sourceMeetingId: 'm-5',
    })
    expect(firstA).not.toBeNull()

    // Now call for co-B with the SAME source_meeting_id — should NOT claim
    // co-A's note; should create a new one tagged to co-B.
    const firstB = createMeetingCompanionNote({
      entityType: 'company',
      entityId: 'co-B',
      content: 'Beta note',
      sourceMeetingId: 'm-5',
    })

    expect(firstB).not.toBeNull()
    expect(firstB!.id).not.toBe(firstA!.id)
    expect(firstB!.companyId).toBe('co-B')
    expect(firstB!.content).toBe('Beta note')

    expect(countNotesFor('company_id', 'co-A')).toBe(1)
    expect(countNotesFor('company_id', 'co-B')).toBe(1)
  })
})
