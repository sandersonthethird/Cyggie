/**
 * Tests for migration 079 — DROP TABLE IF EXISTS company_conversations*.
 *
 * The migration must be idempotent (use IF EXISTS) so it can run on every
 * app launch without crashing. Pre-existing data triggers a warning log.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runDropCompanyConversationsMigration } from '../main/database/migrations/079-drop-company-conversations'

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(':memory:')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('migration 079 — drop company_conversations', () => {
  it('is a no-op on a fresh DB where the tables never existed', () => {
    expect(() => runDropCompanyConversationsMigration(testDb)).not.toThrow()
  })

  it('drops both tables when they exist', () => {
    testDb.exec(`
      CREATE TABLE company_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE company_conversation_messages (id TEXT PRIMARY KEY);
    `)

    runDropCompanyConversationsMigration(testDb)

    const tables = testDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'company_conversation%'`
      )
      .all() as Array<{ name: string }>
    expect(tables.length).toBe(0)
  })

  it('is idempotent — running twice in a row succeeds', () => {
    testDb.exec(`CREATE TABLE company_conversations (id TEXT PRIMARY KEY);`)
    runDropCompanyConversationsMigration(testDb)
    expect(() => runDropCompanyConversationsMigration(testDb)).not.toThrow()
  })

  it('warns when tables contain rows before dropping', () => {
    const warnSpy = vi.spyOn(console, 'warn')
    testDb.exec(`CREATE TABLE company_conversations (id TEXT PRIMARY KEY);`)
    testDb.prepare(`INSERT INTO company_conversations VALUES (?)`).run('x')

    runDropCompanyConversationsMigration(testDb)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping company_conversations with')
    )
  })
})
