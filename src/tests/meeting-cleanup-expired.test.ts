/**
 * Tests for cleanupExpiredScheduledMeetings — the startup cleanup that
 * deletes *truly empty* 'scheduled' stubs older than 2h. After the
 * "i had a meeting" fix, rows with calendar_event_id or attendees survive
 * regardless of age, because the notifier and reconcile seed them.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { cleanupExpiredScheduledMeetings } = await import('@cyggie/db/sqlite/repositories/meeting.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT NOT NULL,
      notes TEXT,
      attendees TEXT,
      calendar_event_id TEXT,
      status TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE meetings_fts USING fts5(
      title,
      meeting_id UNINDEXED
    );
  `)
  return db
}

function insert(row: {
  id: string
  status: string
  date: string
  notes?: string | null
  attendees?: string | null
  calendarEventId?: string | null
}): void {
  testDb
    .prepare(
      `INSERT INTO meetings (id, title, date, notes, attendees, calendar_event_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.id,
      row.date,
      row.notes ?? null,
      row.attendees ?? null,
      row.calendarEventId ?? null,
      row.status,
    )
}

function ids(): string[] {
  return (testDb.prepare(`SELECT id FROM meetings ORDER BY id`).all() as { id: string }[]).map((r) => r.id)
}

describe('cleanupExpiredScheduledMeetings', () => {
  // Three hours ago — past the 2h cutoff.
  const oldDate = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  // One hour from now — future.
  const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString()

  beforeEach(() => {
    testDb = buildDb()
  })

  it('deletes a truly empty scheduled stub (no notes, no calendar link, no attendees)', () => {
    insert({ id: 'stub', status: 'scheduled', date: oldDate })
    expect(cleanupExpiredScheduledMeetings()).toBe(1)
    expect(ids()).toEqual([])
  })

  it('SPARES a scheduled row that carries a calendar_event_id (notifier/reconcile seed)', () => {
    insert({
      id: 'cal-linked',
      status: 'scheduled',
      date: oldDate,
      calendarEventId: 'gcal-evt-1',
    })
    expect(cleanupExpiredScheduledMeetings()).toBe(0)
    expect(ids()).toEqual(['cal-linked'])
  })

  it('SPARES a scheduled row with non-empty attendees', () => {
    insert({
      id: 'with-attendees',
      status: 'scheduled',
      date: oldDate,
      attendees: JSON.stringify(['Jeff Weinstein']),
    })
    expect(cleanupExpiredScheduledMeetings()).toBe(0)
    expect(ids()).toEqual(['with-attendees'])
  })

  it('SPARES a scheduled row with notes (legacy behaviour preserved)', () => {
    insert({ id: 'with-notes', status: 'scheduled', date: oldDate, notes: 'partial agenda' })
    expect(cleanupExpiredScheduledMeetings()).toBe(0)
    expect(ids()).toEqual(['with-notes'])
  })

  it('SPARES a future-dated scheduled row regardless of emptiness', () => {
    insert({ id: 'future', status: 'scheduled', date: futureDate })
    expect(cleanupExpiredScheduledMeetings()).toBe(0)
    expect(ids()).toEqual(['future'])
  })

  it('SPARES non-scheduled rows', () => {
    insert({ id: 'summarized', status: 'summarized', date: oldDate })
    insert({ id: 'error', status: 'error', date: oldDate })
    expect(cleanupExpiredScheduledMeetings()).toBe(0)
    expect(ids()).toEqual(['error', 'summarized'])
  })

  it("treats attendees='[]' as empty (matches stub-row encoding)", () => {
    insert({
      id: 'empty-array',
      status: 'scheduled',
      date: oldDate,
      attendees: '[]',
    })
    expect(cleanupExpiredScheduledMeetings()).toBe(1)
    expect(ids()).toEqual([])
  })

  it('mixed scenario: deletes only truly empty stubs', () => {
    insert({ id: 'a-stub', status: 'scheduled', date: oldDate })
    insert({ id: 'b-calendar', status: 'scheduled', date: oldDate, calendarEventId: 'gcal-2' })
    insert({ id: 'c-notes', status: 'scheduled', date: oldDate, notes: 'hi' })
    insert({ id: 'd-future', status: 'scheduled', date: futureDate })
    insert({ id: 'e-summarized', status: 'summarized', date: oldDate })

    expect(cleanupExpiredScheduledMeetings()).toBe(1)
    expect(ids()).toEqual(['b-calendar', 'c-notes', 'd-future', 'e-summarized'])
  })

  it('also clears meetings_fts entries for deleted stubs', () => {
    insert({ id: 'stub-fts', status: 'scheduled', date: oldDate })
    testDb.prepare(`INSERT INTO meetings_fts (title, meeting_id) VALUES (?, ?)`).run('stub-fts', 'stub-fts')

    expect(cleanupExpiredScheduledMeetings()).toBe(1)
    const ftsRows = testDb.prepare(`SELECT meeting_id FROM meetings_fts`).all()
    expect(ftsRows).toHaveLength(0)
  })
})
