/**
 * Notes blank-insert heal — pull-side reconcile (reconcileBlankNote in
 * sync-remote-apply.ts) + the barrel re-push (note-blank-heal.service.ts).
 *
 * THE BUG: a partial privacy-backfill op='update' blank-inserted some notes on
 * Neon (title NULL, content '') while the desktop kept the real content at an
 * EQUAL lamport — a standoff LWW never breaks, so mobile shows "Untitled" empty.
 *
 * THE FIX under test:
 *  - reconcileBlankNote refuses an incoming blank when the local note has
 *    content AND incoming.lamport <= local.lamport (corruption), and queues the
 *    id for re-push — but APPLIES a blank arriving at a higher lamport (a
 *    deliberate mobile clear).
 *  - repushBlankHealedNotes re-pushes the local content through the barrel so
 *    the Neon blank is overwritten; notes have no largeColumns so the emitted
 *    outbox payload carries `content` (no-trim regression guard).
 *
 * Schema built from the REAL migrations (runAllMigrations) per the
 * schema-parity precedent, so the test can't drift from production.
 */
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { PulledNoteRow } from '@main/services/sync-remote-apply'

let testDb: Database.Database

// repushBlankHealedNotes → barrel getNote/updateNote → getDatabase(); point it
// at the per-test in-memory db while keeping runAllMigrations real.
vi.mock('@cyggie/db/sqlite/connection', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, getDatabase: () => testDb }
})

const { runAllMigrations } = await import('@cyggie/db/sqlite/connection')
const { configureSyncGlobals } = await import('@cyggie/db/sqlite/repositories/_sync')
const { applyRemoteNotes } = await import('@main/services/sync-remote-apply')
const { repushBlankHealedNotes } = await import('@main/services/note-blank-heal.service')

const DEVICE_ID = 'dev-heal'
const USER_ID = 'user-heal'

function migratedDb(): Database.Database {
  const db = new Database(':memory:')
  runAllMigrations(db)
  db.prepare(
    "INSERT INTO sync_state (device_id, user_id, last_pulled_lamport) VALUES (?, ?, '0')",
  ).run(DEVICE_ID, USER_ID)
  // applyRemoteRows pre-checks the owning user exists; seed all NOT-NULL cols.
  const cols = db.prepare(`PRAGMA table_info('users')`).all() as {
    name: string
    type: string
    notnull: number
    dflt_value: unknown
  }[]
  const req = cols.filter((c) => c.name === 'id' || (c.notnull === 1 && c.dflt_value === null))
  db.prepare(
    `INSERT INTO users (${req.map((c) => c.name).join(', ')}) VALUES (${req.map(() => '?').join(', ')})`,
  ).run(...req.map((c) => (c.name === 'id' ? USER_ID : /INT|REAL|NUM/i.test(c.type) ? 0 : 'x')))
  return db
}

function seedLocalNote(
  db: Database.Database,
  o: { id: string; title: string | null; content: string; lamport: string },
): void {
  db.prepare(
    `INSERT INTO notes (id, title, content, lamport, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(o.id, o.title, o.content, o.lamport)
}

const localNote = (db: Database.Database, id: string) =>
  db.prepare('SELECT title, content, lamport FROM notes WHERE id = ?').get(id) as
    | { title: string | null; content: string; lamport: string }
    | undefined

function incoming(o: { id: string; title: string | null; content: string; lamport: string }): PulledNoteRow {
  return {
    id: o.id,
    userId: USER_ID,
    title: o.title,
    content: o.content,
    companyId: null,
    contactId: null,
    sourceMeetingId: null,
    themeId: null,
    isPinned: false,
    isPrivate: false,
    folderPath: null,
    importSource: null,
    sourceDigestId: null,
    createdByUserId: null,
    updatedByUserId: null,
    lamport: o.lamport,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  }
}

describe('reconcileBlankNote (pull-side)', () => {
  it('refuses a corrupted blank (lamport <= local, local has content) and queues a re-push', () => {
    const db = migratedDb()
    seedLocalNote(db, { id: 'n1', title: 'Real title', content: 'Real body', lamport: '100' })
    const repush: string[] = []
    applyRemoteNotes(db, DEVICE_ID, USER_ID, [incoming({ id: 'n1', title: '', content: '', lamport: '100' })], {
      onBlankRepush: (ids) => repush.push(...ids),
    })
    // Local content protected (not wiped), and the id is queued for re-push.
    expect(localNote(db, 'n1')).toMatchObject({ title: 'Real title', content: 'Real body' })
    expect(repush).toEqual(['n1'])
  })

  it('APPLIES a blank arriving at a higher lamport (deliberate mobile clear)', () => {
    const db = migratedDb()
    seedLocalNote(db, { id: 'n2', title: 'Real title', content: 'Real body', lamport: '100' })
    const repush: string[] = []
    applyRemoteNotes(db, DEVICE_ID, USER_ID, [incoming({ id: 'n2', title: '', content: '', lamport: '200' })], {
      onBlankRepush: (ids) => repush.push(...ids),
    })
    expect(localNote(db, 'n2')).toMatchObject({ title: '', content: '' }) // clear propagated
    expect(repush).toEqual([])
  })

  it('applies a blank when the local note is also blank (nothing to protect)', () => {
    const db = migratedDb()
    seedLocalNote(db, { id: 'n3', title: '', content: '', lamport: '100' })
    const repush: string[] = []
    const res = applyRemoteNotes(
      db,
      DEVICE_ID,
      USER_ID,
      [incoming({ id: 'n3', title: '', content: '', lamport: '150' })],
      { onBlankRepush: (ids) => repush.push(...ids) },
    )
    expect(repush).toEqual([])
    expect(res.appliedIds).toEqual(['n3'])
  })

  it('applies real incoming content normally', () => {
    const db = migratedDb()
    seedLocalNote(db, { id: 'n4', title: 'old', content: 'old body', lamport: '100' })
    const repush: string[] = []
    applyRemoteNotes(
      db,
      DEVICE_ID,
      USER_ID,
      [incoming({ id: 'n4', title: 'new', content: 'new body', lamport: '200' })],
      { onBlankRepush: (ids) => repush.push(...ids) },
    )
    expect(localNote(db, 'n4')).toMatchObject({ title: 'new', content: 'new body' })
    expect(repush).toEqual([])
  })

  it('is idempotent: a second pass still refuses + re-queues, never wiping local', () => {
    const db = migratedDb()
    seedLocalNote(db, { id: 'n5', title: 'T', content: 'B', lamport: '100' })
    const blank = incoming({ id: 'n5', title: '', content: '', lamport: '100' })
    const repush: string[] = []
    applyRemoteNotes(db, DEVICE_ID, USER_ID, [blank], { onBlankRepush: (ids) => repush.push(...ids) })
    applyRemoteNotes(db, DEVICE_ID, USER_ID, [blank], { onBlankRepush: (ids) => repush.push(...ids) })
    expect(localNote(db, 'n5')).toMatchObject({ title: 'T', content: 'B' })
    expect(repush).toEqual(['n5', 'n5'])
  })
})

describe('repushBlankHealedNotes (barrel re-push)', () => {
  it('emits a FULL-row outbox entry INCLUDING content (no-trim regression guard)', () => {
    testDb = migratedDb()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => USER_ID,
      getDeviceId: () => DEVICE_ID,
    })
    seedLocalNote(testDb, { id: 'h1', title: 'Healed', content: 'The real body', lamport: '100' })

    const out = repushBlankHealedNotes(['h1'])
    expect(out).toEqual({ repushed: 1, failed: 0 })

    const entry = testDb
      .prepare("SELECT payload, lamport FROM outbox WHERE table_name='notes' ORDER BY rowid DESC LIMIT 1")
      .get() as { payload: string; lamport: string } | undefined
    expect(entry).toBeDefined()
    const payload = JSON.parse(entry!.payload)
    // The heal is worthless if content is trimmed out — assert it's carried.
    expect(payload.content).toBe('The real body')
    // And the re-push mints a fresh lamport ahead of the blank's (100).
    expect(BigInt(entry!.lamport) > 100n).toBe(true)
  })

  it('counts a missing local note as neither repushed nor failed', () => {
    testDb = migratedDb()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => USER_ID,
      getDeviceId: () => DEVICE_ID,
    })
    expect(repushBlankHealedNotes(['nope'])).toEqual({ repushed: 0, failed: 0 })
  })
})
