/**
 * Unit test for the one-time notes privacy backfill
 * (src/main/services/notes-privacy-backfill.service.ts).
 *
 * Verifies the historical pass marks every note with no company tagged
 * (untagged + contact-only) private, enqueues a MINIMAL, type-correct outbox
 * 'update' for each (is_private as a boolean — the Postgres-boolean gotcha
 * guard), leaves company-tagged notes shared, and is one-time via the
 * settings done-flag.
 *
 * In-memory better-sqlite3 with the minimal schema the service touches:
 * notes (+ lamport, + is_private), outbox, sync_state, settings, and the FK
 * parents the notes table references.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '@cyggie/db/sqlite/migrations/052-unified-notes'
import { runNotesFolderPathMigration } from '@cyggie/db/sqlite/migrations/057-notes-folder-path'
import { runNoteFoldersMigration } from '@cyggie/db/sqlite/migrations/058-note-folders'
import { runLamportOnOwnedTablesMigration } from '@cyggie/db/sqlite/migrations/096-lamport-on-owned-tables'
import { runSyncOutboxStateMigration } from '@cyggie/db/sqlite/migrations/097-sync-outbox-state'
import { runNotesIsPrivateMigration } from '@cyggie/db/sqlite/migrations/121-notes-is-private'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { backfillNotesPrivacy } = await import('../main/services/notes-privacy-backfill.service')

interface OutboxRow {
  table_name: string
  row_id: string
  op: 'insert' | 'update' | 'delete'
  payload: string
  lamport: string
}

function readNotesOutbox(): OutboxRow[] {
  return testDb
    .prepare(`SELECT table_name, row_id, op, payload, lamport FROM outbox WHERE table_name = 'notes' ORDER BY id ASC`)
    .all() as OutboxRow[]
}

function isPrivateOf(id: string): number {
  return (testDb.prepare('SELECT is_private FROM notes WHERE id = ?').get(id) as { is_private: number }).is_private
}

function insertNote(opts: { id: string; companyId?: string | null; contactId?: string | null; isPrivate?: number }): void {
  testDb
    .prepare('INSERT INTO notes (id, content, company_id, contact_id, is_private) VALUES (?, ?, ?, ?, ?)')
    .run(opts.id, 'body ' + opts.id, opts.companyId ?? null, opts.contactId ?? null, opts.isPrivate ?? 0)
}

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE themes (id TEXT PRIMARY KEY);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  runUnifiedNotesMigration(db)
  runNotesFolderPathMigration(db)
  runNoteFoldersMigration(db)
  runLamportOnOwnedTablesMigration(db)
  runSyncOutboxStateMigration(db)
  runNotesIsPrivateMigration(db)
  // FK parents + the device id the backfill needs.
  db.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES ('co1', 'Acme')`).run()
  db.prepare(`INSERT INTO contacts (id, full_name) VALUES ('ct1', 'Pat')`).run()
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('syncDeviceId', 'device-1')`).run()
  return db
}

describe('notes privacy backfill', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertNote({ id: 'company', companyId: 'co1' })          // tagged to a company → stays shared
    insertNote({ id: 'contact', contactId: 'ct1' })          // contact-only → privatize
    insertNote({ id: 'untagged' })                            // untagged → privatize
    insertNote({ id: 'alreadyPriv', isPrivate: 1 })           // already private → skip
  })

  it('privatizes notes with no company, leaving company-tagged notes shared', () => {
    const res = backfillNotesPrivacy('user-1')
    expect(res.notesPrivatized).toBe(2)
    expect(res.skipped).toBe(0)

    expect(isPrivateOf('company')).toBe(0)     // company-tagged: unchanged
    expect(isPrivateOf('contact')).toBe(1)     // contact-only: now private
    expect(isPrivateOf('untagged')).toBe(1)    // untagged: now private
    expect(isPrivateOf('alreadyPriv')).toBe(1) // unchanged
  })

  it('enqueues one minimal update per flipped note with is_private as a BOOLEAN', () => {
    backfillNotesPrivacy('user-1')
    const out = readNotesOutbox()
    expect(out).toHaveLength(2)
    const ids = out.map((r) => r.row_id).sort()
    expect(ids).toEqual(['contact', 'untagged'])
    for (const row of out) {
      expect(row.op).toBe('update')
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      // Regression guard: must be the JS boolean `true`, never the SQLite int 1
      // (notes.is_private is a Postgres boolean — a raw int is rejected at /sync/push).
      expect(payload['is_private']).toBe(true)
      expect(payload['is_pinned']).toBeUndefined() // minimal payload — no other columns
      expect(row.lamport).not.toBe('0')
    }
  })

  it('advances lamport on flipped rows', () => {
    backfillNotesPrivacy('user-1')
    const lam = (testDb.prepare('SELECT lamport FROM notes WHERE id = ?').get('untagged') as { lamport: string }).lamport
    expect(lam).not.toBe('0')
  })

  it('is one-time: sets the done flag and a second run is a no-op even with a new untagged note', () => {
    backfillNotesPrivacy('user-1')
    const flag = testDb.prepare("SELECT value FROM settings WHERE key = 'notesPrivacyBackfillV1Done'").get() as { value: string } | undefined
    expect(flag?.value).toBe('1')

    // A note created AFTER the backfill must NOT be re-privatized.
    insertNote({ id: 'newUntagged' })
    const res2 = backfillNotesPrivacy('user-1')
    expect(res2.alreadyDone).toBe(true)
    expect(res2.notesPrivatized).toBe(0)
    expect(isPrivateOf('newUntagged')).toBe(0)
    expect(readNotesOutbox()).toHaveLength(2) // no new outbox rows
  })

  it('skips (without setting the flag) when device_id is missing — retries next launch', () => {
    testDb.prepare("DELETE FROM settings WHERE key = 'syncDeviceId'").run()
    const res = backfillNotesPrivacy('user-1')
    expect(res.notesPrivatized).toBe(0)
    expect(isPrivateOf('untagged')).toBe(0) // untouched
    const flag = testDb.prepare("SELECT value FROM settings WHERE key = 'notesPrivacyBackfillV1Done'").get()
    expect(flag).toBeUndefined()
  })
})
