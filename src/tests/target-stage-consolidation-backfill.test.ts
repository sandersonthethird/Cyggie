// Tests for target-stage-consolidation-backfill.service.ts. The service reads
// raw rows via getDatabase() and writes through the wrapped barrel
// (updateCompany / updateContact / deleteFieldDefinition) — both are mocked so
// the test asserts the merge/delete decisions without the full sync stack.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = 'user-test-1'

let db: Database.Database

const updateCompany = vi.fn()
const updateContact = vi.fn()
// Mock delete actually removes the def so the service's natural idempotency
// (no orphans → no-op) can be exercised.
const deleteFieldDefinition = vi.fn((id: string) => {
  db.prepare('DELETE FROM custom_field_values WHERE field_definition_id = ?').run(id)
  const r = db.prepare('DELETE FROM custom_field_definitions WHERE id = ?').run(id)
  return r.changes > 0
})

vi.mock('@cyggie/db/sqlite/connection', () => ({ getDatabase: () => db }))
vi.mock('@cyggie/db/sqlite/repositories', () => ({
  updateCompany: (...a: unknown[]) => updateCompany(...a),
  updateContact: (...a: unknown[]) => updateContact(...a),
  deleteFieldDefinition: (id: string) => deleteFieldDefinition(id),
}))

const { consolidateTargetStageFields } = await import(
  '@main/services/target-stage-consolidation-backfill.service'
)

function freshDb(): Database.Database {
  const next = new Database(':memory:')
  next.exec(`
    CREATE TABLE custom_field_definitions (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, field_key TEXT NOT NULL,
      label TEXT NOT NULL, field_type TEXT NOT NULL DEFAULT 'multiselect',
      is_builtin INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE custom_field_values (
      id TEXT PRIMARY KEY, field_definition_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, value_text TEXT
    );
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, target_investment_stage TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, investment_stage_focus TEXT);
  `)
  return next
}

function def(id: string, entityType: string, key: string, builtin = 0) {
  db.prepare(
    `INSERT INTO custom_field_definitions (id, entity_type, field_key, label, is_builtin)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, entityType, key, key, builtin)
}
function val(id: string, defId: string, entityType: string, entityId: string, text: string) {
  db.prepare(
    `INSERT INTO custom_field_values (id, field_definition_id, entity_type, entity_id, value_text)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, defId, entityType, entityId, text)
}

describe('consolidateTargetStageFields', () => {
  beforeEach(() => {
    db = freshDb()
    updateCompany.mockClear()
    updateContact.mockClear()
    deleteFieldDefinition.mockClear()
  })
  afterEach(() => db.close())

  it('no-ops when userId is null', () => {
    def('d1', 'company', 'focus')
    expect(consolidateTargetStageFields(null)).toEqual({
      companiesUpdated: 0, contactsUpdated: 0, definitionsDeleted: 0,
    })
    expect(updateCompany).not.toHaveBeenCalled()
    expect(deleteFieldDefinition).not.toHaveBeenCalled()
  })

  it('no-ops when there are no orphan defs', () => {
    def('builtin', 'company', 'targetInvestmentStage', 1) // built-in is ignored
    expect(consolidateTargetStageFields(USER_ID)).toEqual({
      companiesUpdated: 0, contactsUpdated: 0, definitionsDeleted: 0,
    })
    expect(deleteFieldDefinition).not.toHaveBeenCalled()
  })

  it('merges company Focus + Target Stage into target_investment_stage, deduped & canonical', () => {
    def('dFocus', 'company', 'focus')
    def('dStage', 'company', 'target_stage')
    db.prepare("INSERT INTO org_companies (id, target_investment_stage) VALUES ('co1', 'Pre-Seed')").run()
    val('v1', 'dFocus', 'company', 'co1', '["Seed","Series A"]') // JSON form
    val('v2', 'dStage', 'company', 'co1', 'Series A,Series C')   // comma form, overlaps Series A

    const r = consolidateTargetStageFields(USER_ID)

    expect(updateCompany).toHaveBeenCalledTimes(1)
    expect(updateCompany).toHaveBeenCalledWith('co1', {
      targetInvestmentStage: 'Pre-Seed,Seed,Series A,Series C',
    })
    expect(r.companiesUpdated).toBe(1)
    expect(r.definitionsDeleted).toBe(2)
    // Orphan defs (and their values) are gone.
    expect((db.prepare('SELECT COUNT(*) c FROM custom_field_definitions').get() as { c: number }).c).toBe(0)
  })

  it('merges contact Target Stage into investment_stage_focus', () => {
    def('dC', 'contact', 'target_stage')
    db.prepare("INSERT INTO contacts (id, investment_stage_focus) VALUES ('c1', NULL)").run()
    val('cv1', 'dC', 'contact', 'c1', '["Seed"]')

    const r = consolidateTargetStageFields(USER_ID)
    expect(updateContact).toHaveBeenCalledWith('c1', { investmentStageFocus: 'Seed' })
    expect(r.contactsUpdated).toBe(1)
    expect(r.definitionsDeleted).toBe(1)
  })

  it('skips a no-op merge (existing already canonical & complete) but still deletes the orphan', () => {
    def('dStage', 'company', 'target_stage')
    db.prepare("INSERT INTO org_companies (id, target_investment_stage) VALUES ('co1', 'Seed,Series A')").run()
    val('v1', 'dStage', 'company', 'co1', 'Seed') // subset of existing → no change

    const r = consolidateTargetStageFields(USER_ID)
    expect(updateCompany).not.toHaveBeenCalled()
    expect(r.companiesUpdated).toBe(0)
    expect(r.definitionsDeleted).toBe(1) // orphan still removed
  })

  it('is idempotent: a second run finds no orphans', () => {
    def('dFocus', 'company', 'focus')
    db.prepare("INSERT INTO org_companies (id, target_investment_stage) VALUES ('co1', NULL)").run()
    val('v1', 'dFocus', 'company', 'co1', 'Growth')
    consolidateTargetStageFields(USER_ID)
    updateCompany.mockClear()
    deleteFieldDefinition.mockClear()

    const r2 = consolidateTargetStageFields(USER_ID)
    expect(r2).toEqual({ companiesUpdated: 0, contactsUpdated: 0, definitionsDeleted: 0 })
    expect(updateCompany).not.toHaveBeenCalled()
    expect(deleteFieldDefinition).not.toHaveBeenCalled()
  })
})
