/**
 * Tests for partner-meeting.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *   - currentDigestTuesday / nextDigestTuesday — tested via digest-week separately
 *
 * Test coverage diagram:
 *
 *   getActiveDigest ──► auto-creates if none
 *                  ──► returns existing if present (idempotent)
 *
 *   addItem ──► company item (upsert on duplicate)
 *           ──► admin item (each call = new row)
 *           ──► UNIQUE constraint enforcement (direct SQL)
 *
 *   concludeDigest ──► happy path: archive + new digest + items re-sectioned
 *                  ──► carry_over metadata
 *                  ──► rollback: forced failure keeps original active
 *
 *   determineSection ──► all 6 cases (admin, portfolio, pass, new/old screening, priorities)
 *
 *   getSuggestions ──► returns companies with recent touchpoint
 *                  ──► excludes companies already in digest
 *                  ──► excludes dismissed companies
 *
 *   currentDigestTuesday ──► all 7 days of the week
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runPartnerMeetingMigration } from '../main/database/migrations/059-partner-meeting'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const {
  getActiveDigest,
  getDigestById,
  listDigests,
  concludeDigest,
  addItem,
  updateItem,
  deleteItem,
  getSuggestions,
  dismissSuggestion,
  determineSection,
  autoAddDecisionToDigest,
} = await import('../main/database/repositories/partner-meeting.repo')

const { currentDigestTuesday } = await import('../main/utils/digest-week')

// ─── DB helpers ────────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      pipeline_stage TEXT,
      entity_type TEXT NOT NULL DEFAULT 'prospect',
      last_touchpoint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  runPartnerMeetingMigration(db)
  return db
}

function insertCompany(
  db: Database.Database,
  id: string,
  opts: {
    pipelineStage?: string | null
    entityType?: string
    lastTouchpoint?: string | null
    createdAt?: string
  } = {}
): void {
  db.prepare(`
    INSERT INTO org_companies (id, canonical_name, pipeline_stage, entity_type, last_touchpoint, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Company ${id}`,
    opts.pipelineStage ?? null,
    opts.entityType ?? 'prospect',
    opts.lastTouchpoint ?? null,
    opts.createdAt ?? new Date().toISOString(),
  )
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('partner-meeting.repo', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  // ─── getActiveDigest ───────────────────────────────────────────────────────

  describe('getActiveDigest', () => {
    it('auto-creates an active digest when none exists', () => {
      const digest = getActiveDigest()
      expect(digest).not.toBeNull()
      expect(digest.status).toBe('active')
      expect(digest.weekOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(digest.items).toEqual([])
    })

    it('returns the same digest when called twice (idempotent)', () => {
      const first = getActiveDigest()
      const second = getActiveDigest()
      expect(second.id).toBe(first.id)
      const count = testDb
        .prepare(`SELECT COUNT(*) as c FROM partner_meeting_digests WHERE status = 'active'`)
        .get() as { c: number }
      expect(count.c).toBe(1)
    })

    it('created week_of matches currentDigestTuesday()', () => {
      const digest = getActiveDigest()
      expect(digest.weekOf).toBe(currentDigestTuesday())
    })
  })

  // ─── addItem ───────────────────────────────────────────────────────────────

  describe('addItem', () => {
    it('creates a company item', () => {
      insertCompany(testDb, 'co1')
      const digest = getActiveDigest()
      const item = addItem(digest.id, { companyId: 'co1', section: 'new_deals' })
      expect(item.companyId).toBe('co1')
      expect(item.section).toBe('new_deals')
      expect(item.isDiscussed).toBe(false)
      expect(item.carryOver).toBe(false)
    })

    it('upserts company item on duplicate (same company, second add updates fields)', () => {
      insertCompany(testDb, 'co1')
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co1', section: 'new_deals', statusUpdate: 'first' })
      const second = addItem(digest.id, { companyId: 'co1', section: 'existing_deals', statusUpdate: 'second' })

      // Only one row for this company in this digest
      const count = testDb
        .prepare(`SELECT COUNT(*) as c FROM partner_meeting_items WHERE digest_id = ? AND company_id = ?`)
        .get(digest.id, 'co1') as { c: number }
      expect(count.c).toBe(1)

      // Section and status_update updated
      expect(second.section).toBe('existing_deals')
      expect(second.statusUpdate).toBe('second')
    })

    it('creates separate admin items for each addItem call (NULL company_id)', () => {
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: null, section: 'admin', title: 'Item A' })
      addItem(digest.id, { companyId: null, section: 'admin', title: 'Item B' })

      const count = testDb
        .prepare(`SELECT COUNT(*) as c FROM partner_meeting_items WHERE digest_id = ? AND company_id IS NULL`)
        .get(digest.id) as { c: number }
      expect(count.c).toBe(2)
    })
  })

  // ─── UNIQUE constraint ─────────────────────────────────────────────────────

  describe('UNIQUE constraint', () => {
    it('throws on direct duplicate INSERT for same company in same digest', () => {
      insertCompany(testDb, 'co1')
      const digest = getActiveDigest()
      const now = new Date().toISOString()
      testDb.prepare(`
        INSERT INTO partner_meeting_items (id, digest_id, company_id, section, position, is_discussed, carry_over, created_at, updated_at)
        VALUES ('item1', ?, 'co1', 'new_deals', 1.0, 0, 0, ?, ?)
      `).run(digest.id, now, now)

      expect(() => {
        testDb.prepare(`
          INSERT INTO partner_meeting_items (id, digest_id, company_id, section, position, is_discussed, carry_over, created_at, updated_at)
          VALUES ('item2', ?, 'co1', 'new_deals', 2.0, 0, 0, ?, ?)
        `).run(digest.id, now, now)
      }).toThrow()
    })
  })

  // ─── updateItem ────────────────────────────────────────────────────────────

  describe('updateItem', () => {
    it('updates specified fields only', () => {
      insertCompany(testDb, 'co1')
      const digest = getActiveDigest()
      const item = addItem(digest.id, { companyId: 'co1', section: 'new_deals' })
      const updated = updateItem(item.id, { isDiscussed: true, meetingNotes: 'Notes here' })
      expect(updated?.isDiscussed).toBe(true)
      expect(updated?.meetingNotes).toBe('Notes here')
      expect(updated?.section).toBe('new_deals') // unchanged
    })

    it('returns null for unknown itemId', () => {
      const result = updateItem('nonexistent', { isDiscussed: true })
      expect(result).toBeNull()
    })
  })

  // ─── pipelineStage denormalization ────────────────────────────────────────

  describe('pipelineStage in returned items', () => {
    it('listItems includes pipelineStage when company has a stage', () => {
      insertCompany(testDb, 'co1', { pipelineStage: 'diligence' })
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co1', section: 'new_deals' })
      const refreshed = getActiveDigest()
      const item = refreshed.items?.find(i => i.companyId === 'co1')
      expect(item?.pipelineStage).toBe('diligence')
    })

    it('listItems returns pipelineStage as null when company has no stage', () => {
      insertCompany(testDb, 'co2', { pipelineStage: null })
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co2', section: 'new_deals' })
      const refreshed = getActiveDigest()
      const item = refreshed.items?.find(i => i.companyId === 'co2')
      expect(item?.pipelineStage).toBeNull()
    })

    it('addItem (company path) return value includes pipelineStage', () => {
      insertCompany(testDb, 'co3', { pipelineStage: 'screening' })
      const digest = getActiveDigest()
      const item = addItem(digest.id, { companyId: 'co3', section: 'new_deals' })
      expect(item.pipelineStage).toBe('screening')
    })

    it('addItem (admin path) return value has pipelineStage as null', () => {
      const digest = getActiveDigest()
      const item = addItem(digest.id, { companyId: null, section: 'admin', title: 'Agenda' })
      expect(item.pipelineStage).toBeNull()
    })

    it('updateItem return value includes pipelineStage', () => {
      insertCompany(testDb, 'co4', { pipelineStage: 'decision' })
      const digest = getActiveDigest()
      const added = addItem(digest.id, { companyId: 'co4', section: 'existing_deals' })
      const updated = updateItem(added.id, { isDiscussed: true })
      expect(updated?.pipelineStage).toBe('decision')
    })
  })

  // ─── deleteItem ────────────────────────────────────────────────────────────

  describe('deleteItem', () => {
    it('removes the item', () => {
      insertCompany(testDb, 'co1')
      const digest = getActiveDigest()
      const item = addItem(digest.id, { companyId: 'co1', section: 'new_deals' })
      deleteItem(item.id)
      const count = testDb
        .prepare(`SELECT COUNT(*) as c FROM partner_meeting_items WHERE id = ?`)
        .get(item.id) as { c: number }
      expect(count.c).toBe(0)
    })
  })

  // ─── determineSection ─────────────────────────────────────────────────────

  describe('determineSection', () => {
    it('admin item (no company) → admin', () => {
      expect(determineSection(null, null, null)).toBe('admin')
    })

    it('portfolio company → portfolio_updates', () => {
      expect(determineSection('co1', 'portfolio', null)).toBe('portfolio_updates')
    })

    it('pass stage → passing', () => {
      expect(determineSection('co1', 'prospect', 'pass')).toBe('passing')
    })

    it('screening stage → new_deals', () => {
      expect(determineSection('co1', 'prospect', 'screening')).toBe('new_deals')
    })

    it('diligence stage → existing_deals', () => {
      expect(determineSection('co1', 'prospect', 'diligence')).toBe('existing_deals')
    })

    it('no pipeline stage → priorities', () => {
      expect(determineSection('co1', 'prospect', null)).toBe('priorities')
    })

    it('unknown stage → priorities', () => {
      expect(determineSection('co1', 'prospect', 'someunknown')).toBe('priorities')
    })

    it('decision stage → priorities', () => {
      expect(determineSection('co1', 'prospect', 'decision')).toBe('priorities')
    })
  })

  // ─── concludeDigest ───────────────────────────────────────────────────────

  describe('concludeDigest', () => {
    it('archives current digest and creates a new active one', () => {
      const original = getActiveDigest()
      concludeDigest(original.id)

      const archived = getDigestById(original.id)
      expect(archived?.status).toBe('archived')
      expect(archived?.archivedAt).not.toBeNull()

      const newDigest = getActiveDigest()
      expect(newDigest.id).not.toBe(original.id)
      expect(newDigest.status).toBe('active')
    })

    it('carries over items to the new digest with carry_over=true and is_discussed=false', () => {
      insertCompany(testDb, 'co1', { pipelineStage: 'diligence', createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() })
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co1', section: 'existing_deals', brief: 'Brief text', statusUpdate: 'Update' })

      const newDigest = concludeDigest(digest.id)
      expect(newDigest.items).toHaveLength(1)
      expect(newDigest.items![0].companyId).toBe('co1')
      expect(newDigest.items![0].carryOver).toBe(true)
      expect(newDigest.items![0].isDiscussed).toBe(false)
    })

    it('re-sections items based on current company stage at Conclude time', () => {
      // Company was in 'new_deals' section but now has pipeline_stage='pass'
      insertCompany(testDb, 'co1', { pipelineStage: 'pass' })
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co1', section: 'new_deals' })

      const newDigest = concludeDigest(digest.id)
      expect(newDigest.items![0].section).toBe('passing')
    })

    it('resets meeting_notes on carried-over items', () => {
      insertCompany(testDb, 'co1', { pipelineStage: 'diligence', createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() })
      const digest = getActiveDigest()
      const item = addItem(digest.id, { companyId: 'co1', section: 'existing_deals' })
      updateItem(item.id, { meetingNotes: 'Live notes from this week' })

      const newDigest = concludeDigest(digest.id)
      expect(newDigest.items![0].meetingNotes).toBeNull()
    })

    it('rolls back and keeps original active if transaction fails', () => {
      // Need an item so the carry-over INSERT fires inside the transaction
      insertCompany(testDb, 'rollback-co', { pipelineStage: 'diligence', createdAt: new Date(Date.now() - 30 * 86400_000).toISOString() })
      const original = getActiveDigest()
      addItem(original.id, { companyId: 'rollback-co', section: 'existing_deals' })

      // Install a trigger that fires during carry-over INSERT, forcing ABORT
      // (ABORT rolls back the entire enclosing db.transaction())
      testDb.exec(`
        CREATE TRIGGER test_force_rollback
        BEFORE INSERT ON partner_meeting_items
        WHEN NEW.carry_over = 1
        BEGIN
          SELECT RAISE(ABORT, 'Forced failure for rollback test');
        END
      `)

      try {
        expect(() => concludeDigest(original.id)).toThrow()

        // Original digest must still be 'active' — transaction rolled back
        const check = getDigestById(original.id)
        expect(check?.status).toBe('active')
      } finally {
        testDb.exec('DROP TRIGGER IF EXISTS test_force_rollback')
      }
    })
  })

  // ─── listDigests ──────────────────────────────────────────────────────────

  describe('listDigests', () => {
    it('returns summaries ordered newest first', () => {
      const first = getActiveDigest()
      concludeDigest(first.id) // archives first, creates second
      const digests = listDigests()
      expect(digests.length).toBe(2)
      expect(digests[0].weekOf >= digests[1].weekOf).toBe(true)
    })

    it('includes item count', () => {
      insertCompany(testDb, 'co1')
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co1', section: 'new_deals' })
      const summaries = listDigests()
      expect(summaries[0].itemCount).toBe(1)
    })
  })

  // ─── getSuggestions ───────────────────────────────────────────────────────

  describe('getSuggestions', () => {
    it('returns companies with lastTouchpoint since last Tuesday', () => {
      insertCompany(testDb, 'co1', { lastTouchpoint: new Date().toISOString(), pipelineStage: 'screening' })
      const digest = getActiveDigest()
      const suggestions = getSuggestions(digest.id)
      expect(suggestions.some(s => s.companyId === 'co1')).toBe(true)
    })

    it('excludes companies already in the digest', () => {
      insertCompany(testDb, 'co1', { lastTouchpoint: new Date().toISOString(), pipelineStage: 'screening' })
      const digest = getActiveDigest()
      addItem(digest.id, { companyId: 'co1', section: 'new_deals' })
      const suggestions = getSuggestions(digest.id)
      expect(suggestions.some(s => s.companyId === 'co1')).toBe(false)
    })

    it('excludes dismissed companies', () => {
      insertCompany(testDb, 'co1', { lastTouchpoint: new Date().toISOString(), pipelineStage: 'screening' })
      const digest = getActiveDigest()
      dismissSuggestion(digest.id, 'co1')
      const suggestions = getSuggestions(digest.id)
      expect(suggestions.some(s => s.companyId === 'co1')).toBe(false)
    })

    it('dismissSuggestion is idempotent', () => {
      insertCompany(testDb, 'co1', { lastTouchpoint: new Date().toISOString(), pipelineStage: 'screening' })
      const digest = getActiveDigest()
      dismissSuggestion(digest.id, 'co1')
      dismissSuggestion(digest.id, 'co1') // should not throw or duplicate
      const row = testDb
        .prepare(`SELECT dismissed_suggestions FROM partner_meeting_digests WHERE id = ?`)
        .get(digest.id) as { dismissed_suggestions: string }
      const dismissed = JSON.parse(row.dismissed_suggestions)
      expect(dismissed.filter((id: string) => id === 'co1').length).toBe(1)
    })
  })
})

// ─── autoAddDecisionToDigest ──────────────────────────────────────────────────

describe('autoAddDecisionToDigest', () => {
  beforeEach(() => {
    testDb = buildDb()
    getActiveDigest()  // ensure an active digest exists
  })

  it('no-ops silently when no active digest exists', () => {
    // Archive the digest so none is active
    const digest = getActiveDigest()
    testDb.prepare(`UPDATE partner_meeting_digests SET status = 'archived' WHERE id = ?`).run(digest.id)
    insertCompany(testDb, 'c0', { pipelineStage: 'screening' })
    autoAddDecisionToDigest('c0', 'anything')
    // Re-create a fresh digest to check — company should not be in it
    const fresh = getActiveDigest()
    expect(fresh.items?.find(i => i.companyId === 'c0')).toBeUndefined()
  })

  it('inserts a new company with statusUpdate and correct section', () => {
    insertCompany(testDb, 'c1', { pipelineStage: 'diligence' })
    autoAddDecisionToDigest('c1', 'Stage Change: Moved from screening to diligence')
    const digest = getActiveDigest()
    const item = digest.items?.find(i => i.companyId === 'c1')
    expect(item).toBeDefined()
    expect(item?.section).toBe('existing_deals')
    expect(item?.statusUpdate).toBe('Stage Change: Moved from screening to diligence')
  })

  it('upserts existing company: updates section, preserves statusUpdate', () => {
    insertCompany(testDb, 'c2', { pipelineStage: 'screening' })
    autoAddDecisionToDigest('c2', 'Initial add')
    // Simulate stage change to diligence
    testDb.prepare(`UPDATE org_companies SET pipeline_stage = 'diligence' WHERE id = 'c2'`).run()
    // Set a custom statusUpdate the user typed
    const digest = getActiveDigest()
    const item = digest.items?.find(i => i.companyId === 'c2')
    expect(item).toBeDefined()
    testDb.prepare(`UPDATE partner_meeting_items SET status_update = 'User typed notes' WHERE id = ?`).run(item!.id)
    // Trigger autoAdd again (stage changed)
    autoAddDecisionToDigest('c2', 'Moved from screening to diligence')
    const updated = getActiveDigest()
    const updatedItem = updated.items?.find(i => i.companyId === 'c2')
    expect(updatedItem?.section).toBe('existing_deals')         // section updated
    expect(updatedItem?.statusUpdate).toBe('User typed notes')  // preserved
  })

  it('no-ops silently if company does not exist in org_companies', () => {
    autoAddDecisionToDigest('nonexistent-id', 'anything')
    const digest = getActiveDigest()
    expect(digest.items?.find(i => i.companyId === 'nonexistent-id')).toBeUndefined()
  })

  it('places a pipeline-exited company (stage=null) in passing section', () => {
    insertCompany(testDb, 'c3', { pipelineStage: null })
    autoAddDecisionToDigest('c3', 'Removed from pipeline')
    const digest = getActiveDigest()
    const item = digest.items?.find(i => i.companyId === 'c3')
    expect(item?.section).toBe('passing')
  })

  it('does not throw when companyId is empty string', () => {
    expect(() => autoAddDecisionToDigest('', 'test')).not.toThrow()
  })
})

// ─── currentDigestTuesday ─────────────────────────────────────────────────────

describe('currentDigestTuesday', () => {
  it.each([
    [0, 2],  // Sun → +2 → Tue
    [1, 1],  // Mon → +1 → Tue
    [2, 0],  // Tue → +0 → same day
    [3, 6],  // Wed → +6 → next Tue
    [4, 5],  // Thu → +5
    [5, 4],  // Fri → +4
    [6, 3],  // Sat → +3
  ])('day %i of week advances %i days to Tuesday', (dayOfWeek, expectedOffset) => {
    // Build a date that has the desired day-of-week
    // Start from a known Tuesday (2026-03-17 is a Tuesday: getDay() = 2)
    const knownTuesday = new Date('2026-03-17T12:00:00Z')
    const offset = dayOfWeek - 2  // how many days from Tuesday
    const testDate = new Date(knownTuesday)
    testDate.setUTCDate(knownTuesday.getUTCDate() + offset)

    const result = currentDigestTuesday(testDate)
    const resultDate = new Date(result + 'T00:00:00Z')
    const diff = (resultDate.getTime() - testDate.getTime()) / 86400_000

    // diff should equal expectedOffset (Math.abs to avoid -0 vs 0 issue)
    expect(Math.abs(Math.round(diff))).toBe(Math.abs(expectedOffset))
  })
})
