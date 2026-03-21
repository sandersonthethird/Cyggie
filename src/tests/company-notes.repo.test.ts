/**
 * Tests for createCompanyNote dedup guard in company-notes.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *
 * The guard logic:
 *   1. If no existing note for the meeting → create fresh
 *   2. If existing note has same company_id → no-op, return existing
 *   3. If existing note has null company_id (companion) → claim it (set company_id)
 *   4. If existing note has a DIFFERENT company_id → create new note (multi-company meeting)
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

const { createCompanyNote, listCompanyNotes } = await import('../main/database/repositories/company-notes.repo')

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

describe('createCompanyNote dedup guard', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
    testDb.exec(`INSERT INTO org_companies VALUES ('co2', 'Beta')`)
    testDb.exec(`INSERT INTO meetings VALUES ('mtg1', 'Q1 Review')`)
  })

  it('creates fresh note when no existing note for that meeting', () => {
    const note = createCompanyNote({
      companyId: 'co1',
      content: 'Summary',
      sourceMeetingId: 'mtg1',
    })
    expect(note).not.toBeNull()
    expect(note!.companyId).toBe('co1')
    expect(note!.sourceMeetingId).toBe('mtg1')
  })

  it('companion note (null company_id) → sets company_id on existing, no new row created', () => {
    // Insert a companion note (no company_id) with the source_meeting_id
    testDb.exec(`
      INSERT INTO notes (id, content, source_meeting_id, created_at, updated_at)
      VALUES ('companion1', 'companion content', 'mtg1', datetime('now'), datetime('now'))
    `)

    const note = createCompanyNote({
      companyId: 'co1',
      content: 'Summary',
      sourceMeetingId: 'mtg1',
    })

    // Should return the companion note (now claimed)
    expect(note).not.toBeNull()
    expect(note!.id).toBe('companion1')
    expect(note!.companyId).toBe('co1')

    // Exactly one note in DB, not two
    const notes = listCompanyNotes('co1')
    expect(notes).toHaveLength(1)
    expect(notes[0].id).toBe('companion1')
  })

  it('companion note with same company_id already → no-op, returns existing note', () => {
    // Pre-existing note already tagged to co1
    testDb.exec(`
      INSERT INTO notes (id, content, company_id, source_meeting_id, created_at, updated_at)
      VALUES ('note1', 'existing content', 'co1', 'mtg1', datetime('now'), datetime('now'))
    `)

    const note = createCompanyNote({
      companyId: 'co1',
      content: 'Would-be duplicate',
      sourceMeetingId: 'mtg1',
    })

    expect(note!.id).toBe('note1')

    const notes = listCompanyNotes('co1')
    expect(notes).toHaveLength(1)
  })

  it('existing note has DIFFERENT company_id → creates new note (multi-company meeting)', () => {
    // Pre-existing note tagged to co2
    testDb.exec(`
      INSERT INTO notes (id, content, company_id, source_meeting_id, created_at, updated_at)
      VALUES ('note1', 'co2 content', 'co2', 'mtg1', datetime('now'), datetime('now'))
    `)

    const note = createCompanyNote({
      companyId: 'co1',
      content: 'co1 summary',
      sourceMeetingId: 'mtg1',
    })

    // New note was created for co1
    expect(note).not.toBeNull()
    expect(note!.id).not.toBe('note1')
    expect(note!.companyId).toBe('co1')

    // Both notes exist — the original co2 note and the new co1 note
    expect(listCompanyNotes('co1')).toHaveLength(1)
    expect(listCompanyNotes('co2')).toHaveLength(1)
  })

  it('no sourceMeetingId → always creates a new note', () => {
    const a = createCompanyNote({ companyId: 'co1', content: 'note A' })
    const b = createCompanyNote({ companyId: 'co1', content: 'note B' })
    expect(a!.id).not.toBe(b!.id)
    expect(listCompanyNotes('co1')).toHaveLength(2)
  })
})
