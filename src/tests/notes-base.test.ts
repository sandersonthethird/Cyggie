import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { makeEntityNotesRepo } from '@cyggie/db/sqlite/repositories/notes-base'

const mockGetDb = vi.mocked(getDatabase)

/**
 * Tests for the EntityNotesRepo factory's batched `listForEntities` helper
 * (added in the memo-context expansion). Single SQL query with `WHERE
 * entity_fk_col IN (?, ?, ...)` replaces the per-entity N+1 pattern in the
 * memo IPC handler.
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Minimal notes table matching the production schema columns referenced by
  // SELECT_COLS in notes-base.ts.
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

function insertNote(
  db: Database.Database,
  data: { contactId?: string; companyId?: string; content: string; isPinned?: boolean; updatedAt?: string }
): string {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO notes (id, contact_id, company_id, content, is_pinned, updated_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.contactId ?? null,
    data.companyId ?? null,
    data.content,
    data.isPinned ? 1 : 0,
    data.updatedAt ?? new Date().toISOString(),
    data.updatedAt ?? new Date().toISOString(),
  )
  return id
}

describe('makeEntityNotesRepo — listForEntities (batched lookup)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    mockGetDb.mockReturnValue(db)
  })

  it('returns [] for empty input array without firing SQL', () => {
    const repo = makeEntityNotesRepo('contact_id')
    const spy = vi.spyOn(db, 'prepare')
    const result = repo.listForEntities([])
    expect(result).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns notes for any of the given entity ids in a single query', () => {
    const repo = makeEntityNotesRepo('contact_id')
    insertNote(db, { contactId: 'c-1', content: 'note for c-1' })
    insertNote(db, { contactId: 'c-2', content: 'note for c-2' })
    insertNote(db, { contactId: 'c-3', content: 'note for c-3 (NOT requested)' })

    const result = repo.listForEntities(['c-1', 'c-2'])
    expect(result).toHaveLength(2)
    const contactIds = result.map(n => n.contactId).sort()
    expect(contactIds).toEqual(['c-1', 'c-2'])
  })

  it('skips ids with no matching notes (mixed-existence input)', () => {
    const repo = makeEntityNotesRepo('contact_id')
    insertNote(db, { contactId: 'c-1', content: 'real note' })
    const result = repo.listForEntities(['c-1', 'c-nonexistent'])
    expect(result).toHaveLength(1)
    expect(result[0]!.contactId).toBe('c-1')
  })

  it('preserves is_pinned DESC, datetime(updated_at) DESC ordering', () => {
    const repo = makeEntityNotesRepo('contact_id')
    insertNote(db, { contactId: 'c-1', content: 'old unpinned',  updatedAt: '2026-01-01T00:00:00' })
    insertNote(db, { contactId: 'c-2', content: 'new unpinned',  updatedAt: '2026-05-01T00:00:00' })
    insertNote(db, { contactId: 'c-1', content: 'old pinned',    updatedAt: '2026-01-15T00:00:00', isPinned: true })
    insertNote(db, { contactId: 'c-2', content: 'middle pinned', updatedAt: '2026-03-01T00:00:00', isPinned: true })

    const result = repo.listForEntities(['c-1', 'c-2'])
    // Pinned notes first (newest pinned first), then unpinned (newest first).
    expect(result.map(n => n.content)).toEqual([
      'middle pinned',
      'old pinned',
      'new unpinned',
      'old unpinned',
    ])
  })

  it('respects the entityFkCol parameter (company_id vs contact_id)', () => {
    const companyRepo = makeEntityNotesRepo('company_id')
    const contactRepo = makeEntityNotesRepo('contact_id')
    insertNote(db, { companyId: 'co-1', content: 'company note' })
    insertNote(db, { contactId: 'c-1', content: 'contact note' })

    expect(companyRepo.listForEntities(['co-1'])).toHaveLength(1)
    expect(companyRepo.listForEntities(['co-1'])[0]!.companyId).toBe('co-1')

    expect(contactRepo.listForEntities(['c-1'])).toHaveLength(1)
    expect(contactRepo.listForEntities(['c-1'])[0]!.contactId).toBe('c-1')
  })

  it('handles a large id list (300 entities) in one SQL prepare', () => {
    const repo = makeEntityNotesRepo('contact_id')
    const ids: string[] = []
    for (let i = 0; i < 300; i++) {
      const cid = `c-${i}`
      ids.push(cid)
      insertNote(db, { contactId: cid, content: `note ${i}` })
    }
    const result = repo.listForEntities(ids)
    expect(result).toHaveLength(300)
  })
})
