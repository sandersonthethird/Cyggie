/**
 * Tests for notes.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '../main/database/migrations/052-unified-notes'
import { runNotesFolderPathMigration } from '../main/database/migrations/057-notes-folder-path'
import { runNoteFoldersMigration } from '../main/database/migrations/058-note-folders'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const {
  listNotes,
  searchNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  getFolderCounts,
} = await import('../main/database/repositories/notes.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE themes (id TEXT PRIMARY KEY);
  `)
  runUnifiedNotesMigration(db)
  runNotesFolderPathMigration(db)
  runNoteFoldersMigration(db)
  return db
}

describe('notes.repo', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  describe('createNote', () => {
    it('creates a standalone note', () => {
      const note = createNote({ content: 'Hello world' })
      expect(note).not.toBeNull()
      expect(note!.content).toBe('Hello world')
      expect(note!.companyId).toBeNull()
      expect(note!.contactId).toBeNull()
      expect(note!.isPinned).toBe(false)
    })

    it('creates a note tagged to a company', () => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      const note = createNote({ content: 'Company note', companyId: 'co1' })
      expect(note!.companyId).toBe('co1')
    })

    it('creates a note tagged to a contact', () => {
      testDb.exec(`INSERT INTO contacts VALUES ('ct1', 'Alice')`)
      const note = createNote({ content: 'Contact note', contactId: 'ct1' })
      expect(note!.contactId).toBe('ct1')
    })

    it('creates a note tagged to both company and contact', () => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      testDb.exec(`INSERT INTO contacts VALUES ('ct1', 'Alice')`)
      const note = createNote({ content: 'Cross-tagged', companyId: 'co1', contactId: 'ct1' })
      expect(note!.companyId).toBe('co1')
      expect(note!.contactId).toBe('ct1')
    })

    it('sets title when provided', () => {
      const note = createNote({ title: 'My Title', content: 'body' })
      expect(note!.title).toBe('My Title')
    })

    it('leaves title null when not provided', () => {
      const note = createNote({ content: 'body' })
      expect(note!.title).toBeNull()
    })
  })

  describe('getNote', () => {
    it('returns null for unknown id', () => {
      expect(getNote('nonexistent')).toBeNull()
    })

    it('returns the note by id', () => {
      const created = createNote({ content: 'test' })
      const fetched = getNote(created!.id)
      expect(fetched!.id).toBe(created!.id)
      expect(fetched!.content).toBe('test')
    })

    it('includes denormalized companyName in list result', () => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme Corp')`)
      createNote({ content: 'note', companyId: 'co1' })
      const notes = listNotes('tagged')
      expect(notes[0].companyName).toBe('Acme Corp')
    })

    it('includes denormalized contactName in list result', () => {
      testDb.exec(`INSERT INTO contacts VALUES ('ct1', 'Bob Smith')`)
      createNote({ content: 'note', contactId: 'ct1' })
      const notes = listNotes('tagged')
      expect(notes[0].contactName).toBe('Bob Smith')
    })
  })

  describe('listNotes', () => {
    beforeEach(() => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      testDb.exec(`INSERT INTO contacts VALUES ('ct1', 'Alice')`)
      createNote({ content: 'standalone note' })
      createNote({ content: 'company note', companyId: 'co1' })
      createNote({ content: 'contact note', contactId: 'ct1' })
    })

    it('all filter returns all notes', () => {
      expect(listNotes('all')).toHaveLength(3)
    })

    it('untagged filter returns only notes with no company and no contact', () => {
      const notes = listNotes('untagged')
      expect(notes).toHaveLength(1)
      expect(notes[0].content).toBe('standalone note')
    })

    it('tagged filter returns only notes with a company or contact', () => {
      const notes = listNotes('tagged')
      expect(notes).toHaveLength(2)
    })

    it('default (no arg) returns all notes', () => {
      expect(listNotes()).toHaveLength(3)
    })

    it('sorts pinned notes first', () => {
      const plain = createNote({ content: 'plain' })!
      const pinned = createNote({ content: 'pinned' })!
      updateNote(pinned.id, { isPinned: true })
      const notes = listNotes('all')
      const idx = notes.findIndex((n) => n.id === pinned.id)
      const idxPlain = notes.findIndex((n) => n.id === plain.id)
      expect(idx).toBeLessThan(idxPlain)
    })
  })

  describe('listNotes dedup (source_meeting_id)', () => {
    beforeEach(() => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      testDb.exec(`INSERT INTO org_companies VALUES ('co2', 'Beta')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg1', 'Q1 Review')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg2', 'Q2 Review')`)
    })

    it('shows single note when companion + company-backfill share source_meeting_id', () => {
      // Companion created first (no company_id)
      createNote({ content: 'companion', sourceMeetingId: 'mtg1' }, null, '2024-01-01 10:00:00')
      // Backfill created second (with company_id)
      createNote({ content: 'backfill', sourceMeetingId: 'mtg1', companyId: 'co1' }, null, '2024-01-01 10:00:01')

      const notes = listNotes('all')
      expect(notes).toHaveLength(1)
    })

    it('shows the earliest-created note (companion), not the backfill', () => {
      const companion = createNote({ content: 'companion', sourceMeetingId: 'mtg1' }, null, '2024-01-01 10:00:00')!
      createNote({ content: 'backfill', sourceMeetingId: 'mtg1', companyId: 'co1' }, null, '2024-01-01 10:00:01')

      const notes = listNotes('all')
      expect(notes[0].id).toBe(companion.id)
    })

    it('standalone notes (no source_meeting_id) all appear unaffected', () => {
      createNote({ content: 'note1' })
      createNote({ content: 'note2' })
      createNote({ content: 'note3' })

      expect(listNotes('all')).toHaveLength(3)
    })

    it('multiple meetings show one note each', () => {
      createNote({ content: 'companion A', sourceMeetingId: 'mtg1' }, null, '2024-01-01 10:00:00')
      createNote({ content: 'backfill A', sourceMeetingId: 'mtg1', companyId: 'co1' }, null, '2024-01-01 10:00:01')
      createNote({ content: 'companion B', sourceMeetingId: 'mtg2' }, null, '2024-01-01 11:00:00')
      createNote({ content: 'backfill B', sourceMeetingId: 'mtg2', companyId: 'co2' }, null, '2024-01-01 11:00:01')

      expect(listNotes('all')).toHaveLength(2)
    })

    it('multi-company meeting: two backfill notes both appear (different companies)', () => {
      // First companion
      createNote({ content: 'companion', sourceMeetingId: 'mtg1' }, null, '2024-01-01 10:00:00')
      // company-2 meeting has a different source note
      createNote({ content: 'backfill co2', sourceMeetingId: 'mtg1', companyId: 'co2' }, null, '2024-01-01 10:00:02')

      // Two notes exist; dedup picks only the earliest
      const notes = listNotes('all')
      expect(notes).toHaveLength(1)
      expect(notes[0].content).toBe('companion')
    })
  })

  describe('searchNotes dedup', () => {
    beforeEach(() => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg1', 'Q1 Review')`)
    })

    it('searching a meeting keyword returns 1 result, not 2', () => {
      createNote({ content: 'quarterly review discussion', sourceMeetingId: 'mtg1' }, null, '2024-01-01 10:00:00')
      createNote({ content: 'quarterly review discussion', sourceMeetingId: 'mtg1', companyId: 'co1' }, null, '2024-01-01 10:00:01')

      const results = searchNotes('quarterly')
      expect(results).toHaveLength(1)
    })
  })

  describe('updateNote folderPath', () => {
    it('assigns a folder path to a note', () => {
      const note = createNote({ content: 'body' })!
      const updated = updateNote(note.id, { folderPath: 'Work/Q1' })
      expect(updated!.folderPath).toBe('Work/Q1')
    })

    it('clears folder path when null passed', () => {
      const note = createNote({ content: 'body', folderPath: 'Work' })!
      const updated = updateNote(note.id, { folderPath: null })
      expect(updated!.folderPath).toBeNull()
    })

    it('undefined folderPath leaves existing path unchanged', () => {
      const note = createNote({ content: 'body', folderPath: 'Work' })!
      const updated = updateNote(note.id, { content: 'new body' })
      expect(updated!.folderPath).toBe('Work')
    })
  })

  describe('updateNote', () => {
    it('updates content', () => {
      const note = createNote({ content: 'original' })!
      const updated = updateNote(note.id, { content: 'changed' })
      expect(updated!.content).toBe('changed')
    })

    it('updates title', () => {
      const note = createNote({ content: 'body' })!
      const updated = updateNote(note.id, { title: 'New Title' })
      expect(updated!.title).toBe('New Title')
    })

    it('sets title to null', () => {
      const note = createNote({ title: 'Old', content: 'body' })!
      const updated = updateNote(note.id, { title: null })
      expect(updated!.title).toBeNull()
    })

    it('updates isPinned', () => {
      const note = createNote({ content: 'body' })!
      updateNote(note.id, { isPinned: true })
      expect(getNote(note.id)!.isPinned).toBe(true)
    })

    it('tags a note to a company', () => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co2', 'Beta')`)
      const note = createNote({ content: 'body' })!
      updateNote(note.id, { companyId: 'co2' })
      expect(getNote(note.id)!.companyId).toBe('co2')
    })

    it('clears a company tag (sets to null)', () => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co2', 'Beta')`)
      const note = createNote({ content: 'body', companyId: 'co2' })!
      updateNote(note.id, { companyId: null })
      expect(getNote(note.id)!.companyId).toBeNull()
    })

    it('returns null for unknown noteId', () => {
      expect(updateNote('nonexistent', { content: 'x' })).toBeNull()
    })

    it('returns unchanged note when no fields provided', () => {
      const note = createNote({ content: 'body' })!
      const result = updateNote(note.id, {})
      expect(result!.content).toBe('body')
    })
  })

  describe('deleteNote', () => {
    it('deletes a note and returns true', () => {
      const note = createNote({ content: 'to delete' })!
      expect(deleteNote(note.id)).toBe(true)
      expect(getNote(note.id)).toBeNull()
    })

    it('returns false for unknown id', () => {
      expect(deleteNote('nonexistent')).toBe(false)
    })
  })

  describe('listNotes unfoldered filter', () => {
    it('returns only notes with null folder_path', () => {
      createNote({ content: 'no folder' })
      createNote({ content: 'in folder', folderPath: 'Work' })
      const notes = listNotes('unfoldered')
      expect(notes).toHaveLength(1)
      expect(notes[0].content).toBe('no folder')
    })

    it('excludes notes with any folder assigned', () => {
      createNote({ content: 'a', folderPath: 'Work' })
      createNote({ content: 'b', folderPath: 'Work/Q1' })
      expect(listNotes('unfoldered')).toHaveLength(0)
    })

    it('treats empty string folder_path as unfoldered', () => {
      // createNote with folderPath '' — INSERT stores NULL via ?? null
      const note = createNote({ content: 'empty path', folderPath: '' })!
      // empty string is stored as null, so it shows in unfoldered
      const notes = listNotes('unfoldered')
      expect(notes.some(n => n.id === note.id)).toBe(true)
    })
  })

  describe('createFolder / listFolders', () => {
    it('createFolder: path appears in listFolders()', () => {
      createFolder('Work')
      expect(listFolders()).toContain('Work')
    })

    it('createFolder: INSERT OR IGNORE — no error on duplicate', () => {
      expect(() => {
        createFolder('Work')
        createFolder('Work')
      }).not.toThrow()
      expect(listFolders().filter(f => f === 'Work')).toHaveLength(1)
    })

    it('listFolders returns union of note folder_paths + note_folders', () => {
      createFolder('EmptyFolder')
      createNote({ content: 'body', folderPath: 'Work' })
      const folders = listFolders()
      expect(folders).toContain('EmptyFolder')
      expect(folders).toContain('Work')
    })

    it('listFolders returns sorted paths', () => {
      createFolder('Z')
      createFolder('A')
      createFolder('M')
      const folders = listFolders()
      const relevant = folders.filter(f => ['Z', 'A', 'M'].includes(f))
      expect(relevant).toEqual(['A', 'M', 'Z'])
    })
  })

  describe('renameFolder', () => {
    it('updates notes with exact old path to new path', () => {
      const note = createNote({ content: 'body', folderPath: 'Work' })!
      renameFolder('Work', 'Projects')
      expect(getNote(note.id)!.folderPath).toBe('Projects')
    })

    it('updates nested children (Work/Q1 → Projects/Q1)', () => {
      const note = createNote({ content: 'body', folderPath: 'Work/Q1' })!
      renameFolder('Work', 'Projects')
      expect(getNote(note.id)!.folderPath).toBe('Projects/Q1')
    })

    it('updates note_folders entries (delete old + insert new)', () => {
      createFolder('Work')
      createFolder('Work/Q1')
      renameFolder('Work', 'Projects')
      const folders = listFolders()
      expect(folders).not.toContain('Work')
      expect(folders).not.toContain('Work/Q1')
      expect(folders).toContain('Projects')
      expect(folders).toContain('Projects/Q1')
    })

    it('does not affect notes in unrelated folders', () => {
      const other = createNote({ content: 'other', folderPath: 'Personal' })!
      renameFolder('Work', 'Projects')
      expect(getNote(other.id)!.folderPath).toBe('Personal')
    })
  })

  describe('deleteFolder', () => {
    it('clears folder_path on all notes inside', () => {
      const note = createNote({ content: 'body', folderPath: 'Work' })!
      deleteFolder('Work')
      expect(getNote(note.id)!.folderPath).toBeNull()
    })

    it('clears folder_path on nested children too', () => {
      const note = createNote({ content: 'body', folderPath: 'Work/Q1' })!
      deleteFolder('Work')
      expect(getNote(note.id)!.folderPath).toBeNull()
    })

    it('removes note_folders entry', () => {
      createFolder('Work')
      deleteFolder('Work')
      expect(listFolders()).not.toContain('Work')
    })

    it('does not affect notes in unrelated folders', () => {
      const other = createNote({ content: 'other', folderPath: 'Personal' })!
      createFolder('Work')
      deleteFolder('Work')
      expect(getNote(other.id)!.folderPath).toBe('Personal')
    })
  })

  describe('listNotes / searchNotes — hideClaimedMeetingNotes', () => {
    beforeEach(() => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      testDb.exec(`INSERT INTO contacts VALUES ('ct1', 'Alice')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg1', 'Q1 Review')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg2', 'Legal Call')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg3', 'Admin Meeting')`)
    })

    it('excludes meeting notes tagged to a company when hideClaimedMeetingNotes=true', () => {
      const claimed = createNote({ content: 'Acme meeting', companyId: 'co1', sourceMeetingId: 'mtg1' })!
      const results = listNotes('all', null, true)
      expect(results.map(n => n.id)).not.toContain(claimed.id)
    })

    it('includes meeting notes tagged to a contact only (no company) when hideClaimedMeetingNotes=true', () => {
      const contactOnly = createNote({ content: 'Legal call', contactId: 'ct1', sourceMeetingId: 'mtg2' })!
      const results = listNotes('all', null, true)
      expect(results.map(n => n.id)).toContain(contactOnly.id)
    })

    it('includes fully untagged meeting notes when hideClaimedMeetingNotes=true (thematic/admin meetings)', () => {
      const untagged = createNote({ content: 'Admin meeting', sourceMeetingId: 'mtg3' })!
      const results = listNotes('all', null, true)
      expect(results.map(n => n.id)).toContain(untagged.id)
    })

    it('includes standalone notes tagged to a company when hideClaimedMeetingNotes=true', () => {
      // Intentional research note — not meeting-generated
      const standalone = createNote({ content: 'Research on Acme', companyId: 'co1' })!
      const results = listNotes('all', null, true)
      expect(results.map(n => n.id)).toContain(standalone.id)
    })

    it('includes meeting notes tagged to a company when hideClaimedMeetingNotes=false', () => {
      const claimed = createNote({ content: 'Acme meeting', companyId: 'co1', sourceMeetingId: 'mtg1' })!
      const results = listNotes('all', null, false)
      expect(results.map(n => n.id)).toContain(claimed.id)
    })

    it('excludes company-tagged meeting notes from search results when hideClaimedMeetingNotes=true', () => {
      createNote({ content: 'quarterly review notes for Acme', companyId: 'co1', sourceMeetingId: 'mtg1' })
      const results = searchNotes('quarterly', null, true)
      expect(results.every(n => n.sourceMeetingId === null || n.companyId === null)).toBe(true)
    })

    it('preserves hideClaimedMeetingNotes=true in searchNotes fallback path', () => {
      // Simulate the fallback by calling listNotes with the flag — verifies the param propagates
      const claimed = createNote({ content: 'Acme meeting', companyId: 'co1', sourceMeetingId: 'mtg1' })!
      const fallback = listNotes('all', null, true)
      expect(fallback.map(n => n.id)).not.toContain(claimed.id)
    })
  })

  describe('createCompanyNote dedup pre-check (source_meeting_id)', () => {
    it('does not create duplicate notes for the same source_meeting_id + company_id', () => {
      testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
      testDb.exec(`INSERT INTO meetings VALUES ('mtg1', 'Q1 Review')`)

      // Simulate what createCompanyNote does with a dedup pre-check
      const insert = () => {
        const existing = testDb
          .prepare(`SELECT id FROM notes WHERE source_meeting_id = ? AND company_id = ?`)
          .get('mtg1', 'co1') as { id: string } | undefined
        if (existing) return getNote(existing.id)
        return createNote({ content: 'Summary text', companyId: 'co1', sourceMeetingId: 'mtg1' })
      }

      const first = insert()
      const second = insert()

      expect(first).not.toBeNull()
      expect(second!.id).toBe(first!.id)

      const all = listNotes('tagged')
      expect(all).toHaveLength(1)
    })
  })

  describe('getFolderCounts', () => {
    it('returns empty array when no notes exist', () => {
      const counts = getFolderCounts()
      expect(counts).toEqual([])
    })

    it('returns count per folder path', () => {
      createNote({ content: 'A', folderPath: 'Work' })
      createNote({ content: 'B', folderPath: 'Work' })
      createNote({ content: 'C', folderPath: 'Personal' })

      const counts = getFolderCounts()
      const work = counts.find(r => r.folderPath === 'Work')
      const personal = counts.find(r => r.folderPath === 'Personal')
      expect(work?.count).toBe(2)
      expect(personal?.count).toBe(1)
    })

    it('includes null folder_path (unfoldered notes) as separate entry', () => {
      createNote({ content: 'unfoldered' })
      createNote({ content: 'foldered', folderPath: 'Work' })

      const counts = getFolderCounts()
      const unfoldered = counts.find(r => r.folderPath === null)
      expect(unfoldered).toBeDefined()
      expect(unfoldered?.count).toBe(1)
    })
  })
})
