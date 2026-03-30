/**
 * Tests for note-hydration.ts
 *
 * Verifies that hydrateCompanionNote() is a read-only infrastructure operation:
 * it populates note content from the meeting file but must NOT update updated_at.
 *
 * Data flow under test:
 *
 *   hydrateCompanionNote(note)
 *        │
 *        ├── [guard] no sourceMeetingId OR content non-empty ──► return note as-is  (no DB)
 *        │
 *        ├── [guard] no meeting row in DB ──────────────────────► return note as-is  (SELECT only)
 *        │
 *        ├── [guard] no summary/transcript file ────────────────► return note as-is  (SELECT only)
 *        │
 *        └── [happy path] read file → UPDATE content only → return hydrated note
 *                 └── updated_at MUST NOT change (regression guard)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '../main/database/migrations/052-unified-notes'
import type { Note } from '../shared/types/note'

// ---------------------------------------------------------------------------
// Module mocks — must precede dynamic import
// ---------------------------------------------------------------------------

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb,
}))

vi.mock('../main/storage/file-manager', () => ({
  readSummary: vi.fn(),
  readTranscript: vi.fn(),
}))

const { readSummary, readTranscript } = await import('../main/storage/file-manager')
const { hydrateCompanionNote } = await import('../main/ipc/note-hydration')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
    CREATE TABLE themes (id TEXT PRIMARY KEY);
    CREATE TABLE meetings (
      id              TEXT PRIMARY KEY,
      title           TEXT,
      summary_path    TEXT,
      transcript_path TEXT
    );
  `)
  runUnifiedNotesMigration(db)
  return db
}

/** Insert a meeting row (must happen before inserting notes that reference it). */
function insertMeeting(
  db: Database.Database,
  id: string,
  summaryPath: string | null = null,
  transcriptPath: string | null = null,
) {
  db.prepare(
    'INSERT INTO meetings (id, title, summary_path, transcript_path) VALUES (?, ?, ?, ?)',
  ).run(id, 'Test meeting', summaryPath, transcriptPath)
}

/** Insert a note row. The meeting must already exist if sourceMeetingId is provided. */
function insertNote(db: Database.Database, id: string, sourceMeetingId: string | null, content: string) {
  db.prepare(`
    INSERT INTO notes (id, title, content, source_meeting_id, created_at, updated_at)
    VALUES (?, 'Test note', ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')
  `).run(id, content, sourceMeetingId)
}

function getUpdatedAt(db: Database.Database, noteId: string): string {
  const row = db.prepare('SELECT updated_at FROM notes WHERE id = ?').get(noteId) as { updated_at: string }
  return row.updated_at
}

/** Minimal Note object suitable for passing to hydrateCompanionNote. */
function stubNote(overrides: Partial<Note>): Note {
  return {
    id: 'stub',
    title: null,
    content: '',
    sourceMeetingId: null,
    companyId: null,
    contactId: null,
    themeId: null,
    isPinned: false,
    folderPath: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hydrateCompanionNote', () => {
  beforeEach(() => {
    testDb = buildDb()
    vi.mocked(readSummary).mockReset()
    vi.mocked(readTranscript).mockReset()
  })

  it('returns note unchanged when sourceMeetingId is null', () => {
    const note = stubNote({ sourceMeetingId: null, content: '' })
    expect(hydrateCompanionNote(note)).toBe(note)
    expect(readSummary).not.toHaveBeenCalled()
  })

  it('returns note unchanged when content is already populated', () => {
    const note = stubNote({ sourceMeetingId: 'm1', content: 'existing content' })
    expect(hydrateCompanionNote(note)).toBe(note)
    expect(readSummary).not.toHaveBeenCalled()
  })

  it('returns note unchanged when meeting row does not exist in DB', () => {
    // Note has a sourceMeetingId but no corresponding meeting row — SELECT returns undefined
    const note = stubNote({ sourceMeetingId: 'no-such-meeting', content: '' })
    expect(hydrateCompanionNote(note)).toBe(note)
  })

  it('returns note unchanged when no file is readable', () => {
    insertMeeting(testDb, 'm2', '/summary.md', null)
    insertNote(testDb, 'n4', 'm2', '')
    vi.mocked(readSummary).mockReturnValue(null)
    const note = stubNote({ id: 'n4', sourceMeetingId: 'm2', content: '' })
    expect(hydrateCompanionNote(note)).toBe(note)
  })

  it('populates content from summary file on first open', () => {
    insertMeeting(testDb, 'm3', '/summary.md', null)
    insertNote(testDb, 'n5', 'm3', '')
    vi.mocked(readSummary).mockReturnValue('# Meeting summary\n\nSome notes.')
    const note = stubNote({ id: 'n5', sourceMeetingId: 'm3', content: '' })
    const result = hydrateCompanionNote(note)
    expect(result.content).toBe('# Meeting summary\n\nSome notes.')
  })

  it('does not update updated_at when hydrating companion note content', () => {
    // Regression test: viewing a meeting note must not advance the "Edited" timestamp.
    insertMeeting(testDb, 'm4', '/summary.md', null)
    insertNote(testDb, 'n6', 'm4', '')
    vi.mocked(readSummary).mockReturnValue('# Meeting summary')

    const before = getUpdatedAt(testDb, 'n6')
    hydrateCompanionNote(stubNote({ id: 'n6', sourceMeetingId: 'm4', content: '' }))
    const after = getUpdatedAt(testDb, 'n6')

    expect(after).toBe(before)
  })

  it('falls back to transcript when summary path is absent', () => {
    insertMeeting(testDb, 'm5', null, '/transcript.txt')
    insertNote(testDb, 'n7', 'm5', '')
    vi.mocked(readTranscript).mockReturnValue('Transcript content')
    const note = stubNote({ id: 'n7', sourceMeetingId: 'm5', content: '' })
    const result = hydrateCompanionNote(note)
    expect(result.content).toBe('Transcript content')
    expect(readSummary).not.toHaveBeenCalled()
  })
})
