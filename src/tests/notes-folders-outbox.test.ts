/**
 * Integration test for the sync-wrapped `deleteFolder` and `renameFolder`
 * exported from the repositories barrel. Asserts the local outbox receives
 * the correct rows for:
 *
 *   • Single-folder delete: one `delete` row for the root path.
 *   • Nested-folder delete: one `delete` row per matched path (root +
 *     descendants), via the raw repo's cascade emission.
 *   • Rename without children: one `delete` (old path) + one `insert`
 *     (new path) — a PK rename in outbox terms.
 *   • Nested rename: one `delete`/`insert` pair per cascaded path.
 *
 * Boundaries:
 *   • Uses an in-memory better-sqlite3 with the minimal schema the code
 *     path touches (notes, note_folders, outbox, sync_state).
 *   • Imports from the BARREL so the `withSync` wrapper is exercised.
 *   • Configures sync globals so writes can emit outbox rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '@cyggie/db/sqlite/migrations/052-unified-notes'
import { runNotesFolderPathMigration } from '@cyggie/db/sqlite/migrations/057-notes-folder-path'
import { runNoteFoldersMigration } from '@cyggie/db/sqlite/migrations/058-note-folders'
import { runLamportOnOwnedTablesMigration } from '@cyggie/db/sqlite/migrations/096-lamport-on-owned-tables'
import { runSyncOutboxStateMigration } from '@cyggie/db/sqlite/migrations/097-sync-outbox-state'
import { runNotesIsPrivateMigration } from '@cyggie/db/sqlite/migrations/121-notes-is-private'
import { runNotesSoftDeleteMigration } from '@cyggie/db/sqlite/migrations/130-notes-soft-delete'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const {
  createFolder,
  deleteFolder,
  renameFolder,
  createNote,
} = await import('@cyggie/db/sqlite/repositories')

interface OutboxRow {
  table_name: string
  row_id: string
  op: 'insert' | 'update' | 'delete'
  payload: string
}

function readOutbox(): OutboxRow[] {
  return testDb
    .prepare(`SELECT table_name, row_id, op, payload FROM outbox ORDER BY id ASC`)
    .all() as OutboxRow[]
}

function folderOutbox(): OutboxRow[] {
  return readOutbox().filter((r) => r.table_name === 'note_folders')
}

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
  runLamportOnOwnedTablesMigration(db)
  runSyncOutboxStateMigration(db)
  runNotesIsPrivateMigration(db)
  runNotesSoftDeleteMigration(db)
  return db
}

describe('notes folders — sync-wrapped outbox emission', () => {
  beforeEach(() => {
    testDb = buildDb()
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => 'user-1',
      getDeviceId: () => 'device-1',
    })
  })

  describe('deleteFolder', () => {
    it('emits one delete row for an empty leaf folder', () => {
      createFolder('Skills')
      // clear outbox state from the create
      testDb.exec(`DELETE FROM outbox`)

      deleteFolder('Skills')

      const rows = folderOutbox()
      expect(rows).toHaveLength(1)
      expect(rows[0].op).toBe('delete')
      expect(JSON.parse(rows[0].payload)).toEqual({ path: 'Skills' })
    })

    it('emits one delete row per nested descendant path', () => {
      createFolder('Skills')
      createFolder('Skills/Sub')
      createFolder('Skills/Sub/A')
      createFolder('Other') // unrelated — should not be in outbox
      testDb.exec(`DELETE FROM outbox`)

      deleteFolder('Skills')

      const rows = folderOutbox()
      expect(rows).toHaveLength(3)
      expect(rows.every((r) => r.op === 'delete')).toBe(true)
      const paths = rows.map((r) => JSON.parse(r.payload).path).sort()
      expect(paths).toEqual(['Skills', 'Skills/Sub', 'Skills/Sub/A'])
    })

    it('still removes rows locally when called without auth (no outbox)', () => {
      _resetSyncGlobalsForTesting()
      configureSyncGlobals({
        getDb: () => testDb,
        getUserId: () => null,
        getDeviceId: () => null,
      })
      // Need a folder pre-existing under a sync ctx OR insert directly
      testDb.prepare(`INSERT INTO note_folders (path) VALUES ('Skills')`).run()

      deleteFolder('Skills')

      const remaining = testDb
        .prepare(`SELECT path FROM note_folders WHERE path = ?`)
        .get('Skills')
      expect(remaining).toBeUndefined()
      expect(readOutbox()).toHaveLength(0)
    })

    it('clears folder_path on notes inside and emits one delete row', () => {
      createFolder('Skills')
      const note = createNote({ content: 'inside', folderPath: 'Skills' })!
      testDb.exec(`DELETE FROM outbox`)

      deleteFolder('Skills')

      const refreshed = testDb
        .prepare(`SELECT folder_path FROM notes WHERE id = ?`)
        .get(note.id) as { folder_path: string | null }
      expect(refreshed.folder_path).toBeNull()
      expect(folderOutbox()).toHaveLength(1)
    })
  })

  describe('renameFolder', () => {
    it('emits a delete (old) + insert (new) pair for a leaf rename', () => {
      createFolder('Skills')
      testDb.exec(`DELETE FROM outbox`)

      renameFolder('Skills', 'Talents')

      const rows = folderOutbox()
      expect(rows).toHaveLength(2)
      const byOp = Object.fromEntries(
        rows.map((r) => [r.op, JSON.parse(r.payload).path]),
      )
      expect(byOp).toEqual({ delete: 'Skills', insert: 'Talents' })
    })

    it('emits a delete/insert pair per cascaded path (nested)', () => {
      createFolder('Skills')
      createFolder('Skills/Sub')
      testDb.exec(`DELETE FROM outbox`)

      renameFolder('Skills', 'Talents')

      const rows = folderOutbox()
      // Two old paths × (delete + insert) = 4 rows
      expect(rows).toHaveLength(4)
      const deletes = rows.filter((r) => r.op === 'delete').map((r) => JSON.parse(r.payload).path).sort()
      const inserts = rows.filter((r) => r.op === 'insert').map((r) => JSON.parse(r.payload).path).sort()
      expect(deletes).toEqual(['Skills', 'Skills/Sub'])
      expect(inserts).toEqual(['Talents', 'Talents/Sub'])
    })

    it('updates notes folder_path via SUBSTR prefix replacement', () => {
      const note = createNote({ content: 'body', folderPath: 'Skills/Sub' })!
      createFolder('Skills')
      createFolder('Skills/Sub')

      renameFolder('Skills', 'Talents')

      const updated = testDb
        .prepare(`SELECT folder_path FROM notes WHERE id = ?`)
        .get(note.id) as { folder_path: string | null }
      expect(updated.folder_path).toBe('Talents/Sub')
    })
  })
})
