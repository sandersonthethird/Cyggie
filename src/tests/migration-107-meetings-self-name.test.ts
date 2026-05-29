import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMeetingsSelfNameMigration } from '@cyggie/db/sqlite/migrations/107-meetings-self-name'

// Migration 107 adds `meetings.self_name` and backfills from the users
// table via displayName → first+last → email. Mirrors the Postgres
// 0022 migration; both must agree so a meeting row looks the same
// after migration on desktop SQLite and Neon Postgres.

function makeDbWithMeetingsAndUsers(): Database.Database {
  const db = new Database(':memory:')
  // Minimal users + meetings tables matching the columns the backfill
  // SELECT references. Real schema is broader, but unused columns are
  // irrelevant to this test.
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      first_name TEXT,
      last_name TEXT,
      email TEXT
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      created_by_user_id TEXT,
      title TEXT NOT NULL
    );
  `)
  return db
}

function insertUser(
  db: Database.Database,
  opts: { id: string; displayName?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null },
): void {
  db.prepare(
    `INSERT INTO users (id, display_name, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.displayName ?? null, opts.firstName ?? null, opts.lastName ?? null, opts.email ?? null)
}

function insertMeeting(db: Database.Database, id: string, userId: string | null): void {
  db.prepare(`INSERT INTO meetings (id, created_by_user_id, title) VALUES (?, ?, 'm')`).run(id, userId)
}

function getSelfName(db: Database.Database, meetingId: string): string | null {
  const row = db
    .prepare(`SELECT self_name FROM meetings WHERE id = ?`)
    .get(meetingId) as { self_name: string | null } | undefined
  return row?.self_name ?? null
}

describe('migration 107 — meetings.self_name column + backfill', () => {
  it('adds the column if missing', () => {
    const db = makeDbWithMeetingsAndUsers()
    runMeetingsSelfNameMigration(db)
    const cols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
    expect(cols.some((c) => c.name === 'self_name')).toBe(true)
  })

  it('backfills from users.display_name first', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertUser(db, { id: 'u1', displayName: 'Sandy Cass', firstName: 'Sandy', lastName: 'Cass', email: 'sandy@example.com' })
    insertMeeting(db, 'm1', 'u1')

    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm1')).toBe('Sandy Cass')
  })

  it('falls back to first+last when display_name is empty', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertUser(db, { id: 'u2', displayName: '', firstName: 'Andy', lastName: 'Park', email: 'andy@example.com' })
    insertMeeting(db, 'm2', 'u2')

    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm2')).toBe('Andy Park')
  })

  it('falls back to email when display_name and first+last are absent', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertUser(db, { id: 'u3', displayName: null, firstName: null, lastName: null, email: 'lone@example.com' })
    insertMeeting(db, 'm3', 'u3')

    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm3')).toBe('lone@example.com')
  })

  it('leaves self_name NULL when the user row has nothing usable', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertUser(db, { id: 'u4', displayName: null, firstName: null, lastName: null, email: null })
    insertMeeting(db, 'm4', 'u4')

    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm4')).toBeNull()
  })

  it('leaves self_name NULL when the meeting has no matching user row (orphan)', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertMeeting(db, 'm5', 'orphan-user-id')
    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm5')).toBeNull()
  })

  it('idempotent — does not re-run ADD COLUMN or rewrite already-set values', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertUser(db, { id: 'u6', displayName: 'Original', firstName: null, lastName: null, email: null })
    insertMeeting(db, 'm6', 'u6')

    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm6')).toBe('Original')

    // Manually overwrite — the migration should not clobber it on re-run.
    db.prepare(`UPDATE meetings SET self_name = 'User Override' WHERE id = ?`).run('m6')
    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm6')).toBe('User Override')
  })

  it('treats empty-string display_name as missing, falls through to next signal', () => {
    const db = makeDbWithMeetingsAndUsers()
    insertUser(db, { id: 'u7', displayName: '', firstName: '', lastName: '', email: 'fallback@example.com' })
    insertMeeting(db, 'm7', 'u7')

    runMeetingsSelfNameMigration(db)
    expect(getSelfName(db, 'm7')).toBe('fallback@example.com')
  })
})
