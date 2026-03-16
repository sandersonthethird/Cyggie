/**
 * Tests for renameBuiltinOption and countBuiltinOptionUsage.
 * Requires better-sqlite3 (native module) — will fail if compiled against
 * a different Node.js version (same pre-existing constraint as custom-fields.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runCustomFieldDefinitionsMigration } from '../main/database/migrations/039-custom-field-definitions'
import { runBuiltinFieldDefsMigration } from '../main/database/migrations/046-builtin-field-defs'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const {
  renameBuiltinOption,
  countBuiltinOptionUsage,
} = await import('../main/database/repositories/custom-fields.repo')

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT,
      contact_type TEXT
    );
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT,
      pipeline_stage TEXT,
      priority TEXT,
      round TEXT,
      entity_type TEXT,
      target_customer TEXT,
      business_model TEXT,
      product_stage TEXT,
      employee_count_range TEXT
    );
  `)
  runCustomFieldDefinitionsMigration(db)
  runBuiltinFieldDefsMigration(db)
  return db
}

beforeEach(() => {
  testDb = makeTestDb()
})

// ── countBuiltinOptionUsage ────────────────────────────────────────────────────

describe('countBuiltinOptionUsage', () => {
  it('returns correct count for a known fieldKey + value', () => {
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name, pipeline_stage) VALUES (?,?,?)`)
      .run('co1', 'Acme', 'screening')
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name, pipeline_stage) VALUES (?,?,?)`)
      .run('co2', 'Beta', 'screening')
    const count = countBuiltinOptionUsage('pipelineStage', 'screening')
    expect(count).toBe(2)
  })

  it('returns 0 for an unknown fieldKey (not in FIELD_KEY_MAP)', () => {
    const count = countBuiltinOptionUsage('unknownField', 'whatever')
    expect(count).toBe(0)
  })
})

// ── renameBuiltinOption ────────────────────────────────────────────────────────

describe('renameBuiltinOption', () => {
  const STAGE_DEF_ID = 'builtin:pipelineStage'

  function addOption(defId: string, option: string) {
    const row = testDb
      .prepare(`SELECT options_json FROM custom_field_definitions WHERE id = ?`)
      .get(defId) as { options_json: string | null }
    const arr: string[] = row.options_json ? JSON.parse(row.options_json) : []
    testDb.prepare(`UPDATE custom_field_definitions SET options_json = ? WHERE id = ?`)
      .run(JSON.stringify([...arr, option]), defId)
  }

  function getOptionsJson(defId: string): string | null {
    const row = testDb
      .prepare(`SELECT options_json FROM custom_field_definitions WHERE id = ?`)
      .get(defId) as { options_json: string | null }
    return row.options_json
  }

  it('renames the option in options_json array', () => {
    addOption(STAGE_DEF_ID, 'my_stage')
    renameBuiltinOption(STAGE_DEF_ID, 'pipelineStage', 'my_stage', 'renamed_stage')
    const arr: string[] = JSON.parse(getOptionsJson(STAGE_DEF_ID) ?? '[]')
    expect(arr).toContain('renamed_stage')
    expect(arr).not.toContain('my_stage')
  })

  it('updates org_companies record in same transaction (both writes commit together)', () => {
    addOption(STAGE_DEF_ID, 'my_stage')
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name, pipeline_stage) VALUES (?,?,?)`)
      .run('co1', 'Acme', 'my_stage')
    renameBuiltinOption(STAGE_DEF_ID, 'pipelineStage', 'my_stage', 'renamed_stage')
    const row = testDb
      .prepare(`SELECT pipeline_stage FROM org_companies WHERE id = ?`)
      .get('co1') as { pipeline_stage: string }
    expect(row.pipeline_stage).toBe('renamed_stage')
  })

  it('updates contacts record for contactType field', () => {
    const CONTACT_DEF_ID = 'builtin:contactType'
    addOption(CONTACT_DEF_ID, 'vip')
    testDb.prepare(`INSERT INTO contacts (id, full_name, contact_type) VALUES (?,?,?)`)
      .run('c1', 'Alice', 'vip')
    renameBuiltinOption(CONTACT_DEF_ID, 'contactType', 'vip', 'vip_plus')
    const row = testDb
      .prepare(`SELECT contact_type FROM contacts WHERE id = ?`)
      .get('c1') as { contact_type: string }
    expect(row.contact_type).toBe('vip_plus')
  })

  it('is a no-op when the value is not in the options array', () => {
    addOption(STAGE_DEF_ID, 'my_stage')
    renameBuiltinOption(STAGE_DEF_ID, 'pipelineStage', 'nonexistent', 'renamed')
    const arr: string[] = JSON.parse(getOptionsJson(STAGE_DEF_ID) ?? '[]')
    expect(arr).toEqual(['my_stage'])
  })

  it('handles null options_json gracefully — treats as empty, is a no-op', () => {
    // STAGE_DEF_ID starts with options_json = NULL; should not throw
    expect(() => {
      renameBuiltinOption(STAGE_DEF_ID, 'pipelineStage', 'ghost', 'new_name')
    }).not.toThrow()
    expect(getOptionsJson(STAGE_DEF_ID)).toBeNull()
  })
})
