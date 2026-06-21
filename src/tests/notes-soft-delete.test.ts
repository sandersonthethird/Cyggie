/**
 * Notes soft-delete (cross-device delete replication).
 *
 * softDeleteNote is an UPDATE that must emit an outbox row with op:'update'
 * (NOT 'delete') — emitting a delete would hard-delete the Neon row firm-wide
 * and break replication. It hides the note from every read; a pulled remote
 * soft-delete hides it locally via the apply path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'
import type { PulledNoteRow } from '@main/services/sync-remote-apply'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const repo = await import('@cyggie/db/sqlite/repositories')
const { applyRemoteNotes } = await import('@main/services/sync-remote-apply')

function outboxRows(table: string): { op: string }[] {
  return testDb
    .prepare(`SELECT op FROM outbox WHERE table_name = ? ORDER BY id`)
    .all(table) as { op: string }[]
}
function bare(id: string): Record<string, unknown> | undefined {
  return testDb.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES ('user-1','u1@example.com','User One')`)
    .run()
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({ getDb: () => testDb, getUserId: () => 'user-1', getDeviceId: () => 'device-1' })
})

describe('softDeleteNote', () => {
  it('emits an outbox UPDATE (not a delete) carrying deleted_at', () => {
    const note = repo.createNote({ content: 'delete me' }, 'user-1')!
    testDb.prepare(`DELETE FROM outbox`).run()

    const result = repo.softDeleteNote(note.id, 'user-1')
    expect(result).toBeTruthy()

    // THE landmine: exactly one outbox row, op:'update' — never 'delete'.
    const rows = outboxRows('notes')
    expect(rows.length).toBe(1)
    expect(rows[0].op).toBe('update')

    // deleted_at stamped on the local row.
    expect(bare(note.id)!.deleted_at).not.toBeNull()
  })

  it('hides the note from getNote + listNotes + folder counts', () => {
    const keep = repo.createNote({ content: 'keep', folderPath: 'F' }, 'user-1')!
    const drop = repo.createNote({ content: 'drop', folderPath: 'F' }, 'user-1')!

    repo.softDeleteNote(drop.id, 'user-1')

    expect(repo.getNote(drop.id)).toBeNull()
    expect(repo.getNote(keep.id)).not.toBeNull()
    const ids = repo.listNotes('all').map((n) => n.id)
    expect(ids).toContain(keep.id)
    expect(ids).not.toContain(drop.id)
    // Folder "F" now counts only the surviving note.
    const fCount = repo.getFolderCounts().find((c) => c.folderPath === 'F')
    expect(fCount?.count).toBe(1)
  })

  it('re-deleting a trashed note is a no-op (no second outbox row)', () => {
    const note = repo.createNote({ content: 'x' }, 'user-1')!
    repo.softDeleteNote(note.id, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()
    repo.softDeleteNote(note.id, 'user-1') // already deleted → WHERE deleted_at IS NULL matches nothing
    expect(outboxRows('notes').length).toBe(0)
  })
})

describe('applyRemoteNotes — pulled soft-delete', () => {
  it('a remote row with deletedAt set hides the local note', () => {
    const note = repo.createNote({ content: 'local' }, 'user-1')!
    expect(repo.getNote(note.id)).not.toBeNull()

    const pulled: PulledNoteRow = {
      id: note.id,
      userId: 'user-1',
      title: null,
      content: 'local',
      companyId: null,
      contactId: null,
      sourceMeetingId: null,
      themeId: null,
      isPinned: false,
      isPrivate: false,
      folderPath: null,
      importSource: null,
      sourceDigestId: null,
      createdByUserId: 'user-1',
      updatedByUserId: 'user-1',
      deletedAt: new Date().toISOString(),
      deletedByUserId: 'user-1',
      lamport: '999999999999',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    applyRemoteNotes(testDb, 'device-2', 'user-1', [pulled])

    expect(bare(note.id)!.deleted_at).not.toBeNull()
    expect(repo.getNote(note.id)).toBeNull()
  })
})
