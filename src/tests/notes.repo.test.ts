/**
 * Tests for notes.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '../main/database/migrations/052-unified-notes'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const {
  listNotes,
  getNote,
  createNote,
  updateNote,
  deleteNote
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
})
