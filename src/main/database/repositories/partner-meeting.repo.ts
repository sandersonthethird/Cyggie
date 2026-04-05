/**
 * partner-meeting.repo.ts
 *
 * Digest lifecycle state machine:
 *
 *   created ──► active ──► [concludeDigest()] ──► archived
 *                                                      │
 *                                           (new active digest created
 *                                            in same DB transaction)
 *
 * Key invariant: exactly one 'active' digest exists at any time.
 * Enforced by partial UNIQUE index on partner_meeting_digests(status) WHERE status='active'.
 *
 * Item UNIQUE constraint behaviour:
 *   Company items: UNIQUE(digest_id, company_id) → upsert via ON CONFLICT DO UPDATE
 *   Admin items:   company_id IS NULL → NULL != NULL in SQLite, so UNIQUE doesn't fire.
 *                  Each addItem() call for an admin item creates a new row (intentional).
 */

import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import { currentDigestTuesday, nextDigestTuesday, previousTuesday } from '../../utils/digest-week'
import type {
  PartnerMeetingDigest,
  PartnerMeetingDigestSummary,
  PartnerMeetingItem,
  AddToSyncInput,
  UpdateItemInput,
  DigestSection,
  DigestSuggestion,
} from '../../../shared/types/partner-meeting'

// ─── Row types ────────────────────────────────────────────────────────────────

interface DigestRow {
  id: string
  week_of: string
  status: string
  dismissed_suggestions: string
  meeting_id: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

interface ItemRow {
  id: string
  digest_id: string
  company_id: string | null
  company_name: string | null
  pipeline_stage: string | null
  section: string
  position: number
  title: string | null
  brief: string | null
  status_update: string | null
  meeting_notes: string | null
  is_discussed: number
  carry_over: number
  created_at: string
  updated_at: string
}

interface ItemWithCompanyRow extends ItemRow {
  pipeline_stage: string | null
  entity_type: string | null
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToDigest(row: DigestRow, items?: PartnerMeetingItem[]): PartnerMeetingDigest {
  return {
    id: row.id,
    weekOf: row.week_of,
    status: row.status as 'active' | 'archived',
    dismissedSuggestions: JSON.parse(row.dismissed_suggestions || '[]'),
    meetingId: row.meeting_id ?? null,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
  }
}

function rowToItem(row: ItemRow): PartnerMeetingItem {
  return {
    id: row.id,
    digestId: row.digest_id,
    companyId: row.company_id,
    companyName: row.company_name,
    pipelineStage: row.pipeline_stage ?? null,
    section: row.section as DigestSection,
    position: row.position,
    title: row.title,
    brief: row.brief,
    statusUpdate: row.status_update,
    meetingNotes: row.meeting_notes,
    isDiscussed: row.is_discussed === 1,
    carryOver: row.carry_over === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ─── Section assignment (used during Conclude rollover) ───────────────────────

/**
 * Determines which section a carried-over item should belong to next week,
 * based on the company's CURRENT pipeline stage at the time of Conclude.
 *
 *   admin (no company)         → 'admin'
 *   entity_type = 'portfolio'  → 'portfolio_updates'
 *   pipeline_stage = 'pass'    → 'passing'
 *   pipeline_stage = 'screening' → 'new_deals'   (shown as "Screening")
 *   pipeline_stage = 'diligence' → 'existing_deals' (shown as "Diligence")
 *   otherwise                  → 'priorities'
 */
export function determineSection(
  companyId: string | null,
  entityType: string | null,
  pipelineStage: string | null,
): DigestSection {
  if (!companyId) return 'admin'
  if (entityType === 'portfolio') return 'portfolio_updates'
  if (pipelineStage === 'pass') return 'passing'
  if (pipelineStage === 'screening') return 'new_deals'
  if (pipelineStage === 'diligence') return 'existing_deals'
  return 'priorities'
}

// ─── Fractional position helpers ─────────────────────────────────────────────

function getNextPosition(digestId: string, section: DigestSection): number {
  const db = getDatabase()
  const row = db
    .prepare(
      `SELECT MAX(position) as max_pos FROM partner_meeting_items
       WHERE digest_id = ? AND section = ?`,
    )
    .get(digestId, section) as { max_pos: number | null }
  return (row.max_pos ?? 0) + 1.0
}

// ─── Digest CRUD ──────────────────────────────────────────────────────────────

/**
 * Returns the current active digest, creating one for the current/next Tuesday
 * if none exists.
 */
export function getActiveDigest(): PartnerMeetingDigest {
  const db = getDatabase()
  const existing = db
    .prepare(`SELECT * FROM partner_meeting_digests WHERE status = 'active' LIMIT 1`)
    .get() as DigestRow | undefined

  if (existing) {
    const items = getItemsForDigest(existing.id)
    return rowToDigest(existing, items)
  }

  // Create a new active digest for the current/next Tuesday
  const id = randomUUID()
  const now = new Date().toISOString()
  const weekOf = currentDigestTuesday()
  db.prepare(
    `INSERT INTO partner_meeting_digests (id, week_of, status, dismissed_suggestions, created_at, updated_at)
     VALUES (?, ?, 'active', '[]', ?, ?)`,
  ).run(id, weekOf, now, now)

  return rowToDigest(
    db.prepare(`SELECT * FROM partner_meeting_digests WHERE id = ?`).get(id) as DigestRow,
    [],
  )
}

export function getDigestById(id: string): PartnerMeetingDigest | null {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT * FROM partner_meeting_digests WHERE id = ?`)
    .get(id) as DigestRow | undefined
  if (!row) return null
  const items = getItemsForDigest(id)
  return rowToDigest(row, items)
}

export function listDigests(): PartnerMeetingDigestSummary[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT d.id, d.week_of, d.status, d.archived_at,
              COUNT(i.id) as item_count
       FROM partner_meeting_digests d
       LEFT JOIN partner_meeting_items i ON i.digest_id = d.id
       GROUP BY d.id
       ORDER BY d.week_of DESC`,
    )
    .all() as (DigestRow & { item_count: number })[]

  return rows.map(r => ({
    id: r.id,
    weekOf: r.week_of,
    status: r.status as 'active' | 'archived',
    archivedAt: r.archived_at,
    itemCount: r.item_count,
  }))
}

/**
 * Archives the active digest and creates next week's digest with items rolled over.
 *
 * Transaction:
 *   1. UPDATE current digest → archived
 *   2. INSERT new digest for next Tuesday
 *   3. Fetch all items + current company stages (single JOIN, no N+1)
 *   4. Re-section each item based on current stage
 *   5. INSERT items into new digest (carry_over=true, is_discussed=false)
 *
 * If any step fails → full rollback → original digest remains active.
 */
export function concludeDigest(digestId: string): PartnerMeetingDigest {
  const db = getDatabase()

  const conclude = db.transaction(() => {
    const now = new Date().toISOString()

    // 1. Archive current digest
    db.prepare(
      `UPDATE partner_meeting_digests SET status='archived', archived_at=?, updated_at=? WHERE id=?`,
    ).run(now, now, digestId)

    // 2. Create next digest
    const newId = randomUUID()
    const weekOf = nextDigestTuesday()
    db.prepare(
      `INSERT INTO partner_meeting_digests (id, week_of, status, dismissed_suggestions, created_at, updated_at)
       VALUES (?, ?, 'active', '[]', ?, ?)`,
    ).run(newId, weekOf, now, now)

    // 3. Fetch all items + current company stages (single JOIN — no N+1)
    const itemRows = db
      .prepare(
        `SELECT pmi.*,
                oc.pipeline_stage, oc.entity_type,
                oc.canonical_name AS company_name
         FROM partner_meeting_items pmi
         LEFT JOIN org_companies oc ON pmi.company_id = oc.id
         WHERE pmi.digest_id = ?
         ORDER BY pmi.section, pmi.position`,
      )
      .all(digestId) as ItemWithCompanyRow[]

    // 4 & 5. Re-section and insert into new digest
    // Track position per section in the new digest
    const sectionPositions: Record<string, number> = {}
    for (const row of itemRows) {
      const newSection = determineSection(
        row.company_id,
        row.entity_type,
        row.pipeline_stage,
      )
      sectionPositions[newSection] = (sectionPositions[newSection] ?? 0) + 1.0
      const newItemId = randomUUID()
      db.prepare(
        `INSERT INTO partner_meeting_items
           (id, digest_id, company_id, section, position, title,
            brief, status_update, meeting_notes,
            is_discussed, carry_over, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
      ).run(
        newItemId, newId, row.company_id, newSection,
        sectionPositions[newSection], row.title,
        row.brief, row.status_update, null,  // meeting_notes reset each week
        now, now,
      )
    }

    return newId
  })

  const newId = conclude()
  return getActiveDigest()
}

// ─── Item CRUD ────────────────────────────────────────────────────────────────

function getItemsForDigest(digestId: string): PartnerMeetingItem[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT pmi.*, oc.canonical_name AS company_name, oc.pipeline_stage
       FROM partner_meeting_items pmi
       LEFT JOIN org_companies oc ON pmi.company_id = oc.id
       WHERE pmi.digest_id = ?
       ORDER BY pmi.section, pmi.position`,
    )
    .all(digestId) as ItemRow[]
  return rows.map(rowToItem)
}

/**
 * Adds or updates an item in the active digest.
 *
 * Company items: upsert via ON CONFLICT(digest_id, company_id) DO UPDATE.
 * Admin items (company_id=null): plain INSERT — UNIQUE doesn't fire for NULLs;
 *   each call intentionally creates a new admin entry.
 */
export function addItem(digestId: string, input: AddToSyncInput): PartnerMeetingItem {
  const db = getDatabase()
  const now = new Date().toISOString()
  const id = randomUUID()

  if (input.companyId) {
    // Company item: upsert
    const position = getNextPosition(digestId, input.section)
    db.prepare(
      `INSERT INTO partner_meeting_items
         (id, digest_id, company_id, section, position, brief, status_update, is_discussed, carry_over, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(digest_id, company_id) DO UPDATE SET
         section=excluded.section,
         brief=COALESCE(excluded.brief, brief),
         status_update=COALESCE(excluded.status_update, status_update),
         updated_at=excluded.updated_at`,
    ).run(
      id, digestId, input.companyId, input.section, position,
      input.brief ?? null, input.statusUpdate ?? null, now, now,
    )
    // Return the upserted row (id may differ if it was an update)
    const row = db
      .prepare(
        `SELECT pmi.*, oc.canonical_name AS company_name, oc.pipeline_stage
         FROM partner_meeting_items pmi
         LEFT JOIN org_companies oc ON pmi.company_id = oc.id
         WHERE pmi.digest_id = ? AND pmi.company_id = ?`,
      )
      .get(digestId, input.companyId) as ItemRow
    return rowToItem(row)
  } else {
    // Admin item: plain INSERT (each call creates a new row)
    const position = getNextPosition(digestId, 'admin')
    db.prepare(
      `INSERT INTO partner_meeting_items
         (id, digest_id, company_id, section, position, title, is_discussed, carry_over, created_at, updated_at)
       VALUES (?, ?, NULL, 'admin', ?, ?, 0, 0, ?, ?)`,
    ).run(id, digestId, position, input.title ?? null, now, now)
    const row = db
      .prepare(
        `SELECT pmi.*, NULL AS company_name, NULL AS pipeline_stage
         FROM partner_meeting_items pmi
         WHERE pmi.id = ?`,
      )
      .get(id) as ItemRow
    return rowToItem(row)
  }
}

/**
 * Fire-and-forget: adds (or re-sections) a company in the active digest when a decision is logged.
 *
 * - No active digest: returns immediately (does not create one).
 * - New company: inserts with statusUpdate pre-filled from the decision description.
 * - Existing company: upserts to update section (stage may have changed); preserves statusUpdate.
 * - Company not found in org_companies: warns + no-ops.
 * - Any DB error: caught and logged, never propagates.
 *
 * Data flow:
 *   active digest? ──► check existing item ──► get company row
 *        │                    │                       │
 *        ▼                    ▼                       ▼
 *   [none → return]   [null → pre-fill]      [null → warn+return]
 *                     [found → null SU]
 *                             │
 *                             ▼
 *                      determineSection()
 *                             │
 *                      [null stage, non-portfolio → 'passing']
 *                             │
 *                             ▼
 *                      addItem() upsert
 */
export function autoAddDecisionToDigest(companyId: string, statusUpdate: string): void {
  try {
    const db = getDatabase()

    // Do NOT create a digest if none exists — stage changes should not have that side effect
    const digestRow = db
      .prepare(`SELECT id FROM partner_meeting_digests WHERE status = 'active' LIMIT 1`)
      .get() as { id: string } | undefined
    if (!digestRow) return

    const digestId = digestRow.id

    // Preserve user-typed statusUpdate for existing items; pre-fill for new ones
    const existing = db
      .prepare(`SELECT id FROM partner_meeting_items WHERE digest_id = ? AND company_id = ? LIMIT 1`)
      .get(digestId, companyId) as { id: string } | undefined
    const resolvedStatusUpdate = existing ? null : statusUpdate

    const companyRow = db
      .prepare(`SELECT entity_type, pipeline_stage FROM org_companies WHERE id = ? LIMIT 1`)
      .get(companyId) as { entity_type: string | null; pipeline_stage: string | null } | undefined
    if (!companyRow) {
      console.warn('[partner-meeting] autoAddDecisionToDigest: company not found', companyId)
      return
    }

    let section = determineSection(companyId, companyRow.entity_type, companyRow.pipeline_stage)
    // Pipeline exit (stage=null, non-portfolio) → 'passing', not 'priorities'
    if (companyRow.pipeline_stage === null && section === 'priorities') section = 'passing'

    addItem(digestId, { companyId, section, statusUpdate: resolvedStatusUpdate })
    console.log('[partner-meeting] autoAdd: companyId=%s section=%s existing=%s', companyId, section, !!existing)
  } catch (err) {
    console.error('[partner-meeting] autoAddDecisionToDigest failed:', err)
  }
}

export function updateItem(itemId: string, input: UpdateItemInput): PartnerMeetingItem | null {
  const db = getDatabase()
  const now = new Date().toISOString()

  const setClauses: string[] = ['updated_at = ?']
  const params: unknown[] = [now]

  if (input.brief !== undefined) { setClauses.push('brief = ?'); params.push(input.brief) }
  if (input.statusUpdate !== undefined) { setClauses.push('status_update = ?'); params.push(input.statusUpdate) }
  if (input.meetingNotes !== undefined) { setClauses.push('meeting_notes = ?'); params.push(input.meetingNotes) }
  if (input.isDiscussed !== undefined) { setClauses.push('is_discussed = ?'); params.push(input.isDiscussed ? 1 : 0) }
  if (input.section !== undefined) { setClauses.push('section = ?'); params.push(input.section) }
  if (input.position !== undefined) { setClauses.push('position = ?'); params.push(input.position) }

  params.push(itemId)
  db.prepare(`UPDATE partner_meeting_items SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)

  const row = db
    .prepare(
      `SELECT pmi.*, oc.canonical_name AS company_name, oc.pipeline_stage
       FROM partner_meeting_items pmi
       LEFT JOIN org_companies oc ON pmi.company_id = oc.id
       WHERE pmi.id = ?`,
    )
    .get(itemId) as ItemRow | undefined
  return row ? rowToItem(row) : null
}

export function deleteItem(itemId: string): void {
  const db = getDatabase()
  db.prepare(`DELETE FROM partner_meeting_items WHERE id = ?`).run(itemId)
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

/**
 * Returns companies with lastTouchpoint since the previous Tuesday that:
 *   - are not already in the current digest
 *   - have not been dismissed by the partner
 */
export function getSuggestions(digestId: string): DigestSuggestion[] {
  const db = getDatabase()

  const digestRow = db
    .prepare(`SELECT dismissed_suggestions FROM partner_meeting_digests WHERE id = ?`)
    .get(digestId) as { dismissed_suggestions: string } | undefined
  if (!digestRow) return []

  const dismissed: string[] = JSON.parse(digestRow.dismissed_suggestions || '[]')
  const lastTuesday = previousTuesday()

  const existing = db
    .prepare(`SELECT company_id FROM partner_meeting_items WHERE digest_id = ? AND company_id IS NOT NULL`)
    .all(digestId) as { company_id: string }[]
  const existingIds = new Set(existing.map(r => r.company_id))

  const rows = db
    .prepare(
      `SELECT id, canonical_name, last_touchpoint
       FROM org_companies
       WHERE last_touchpoint >= ?
         AND entity_type IN ('prospect', 'portfolio')
         AND pipeline_stage IS NOT NULL
       ORDER BY last_touchpoint DESC
       LIMIT 20`,
    )
    .all(lastTuesday) as { id: string; canonical_name: string; last_touchpoint: string }[]

  return rows
    .filter(r => !existingIds.has(r.id) && !dismissed.includes(r.id))
    .map(r => ({
      companyId: r.id,
      companyName: r.canonical_name,
      lastTouchpoint: r.last_touchpoint,
      activitySummary: 'Recent activity',
    }))
}

export function dismissSuggestion(digestId: string, companyId: string): void {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT dismissed_suggestions FROM partner_meeting_digests WHERE id = ?`)
    .get(digestId) as { dismissed_suggestions: string } | undefined
  if (!row) return

  const dismissed: string[] = JSON.parse(row.dismissed_suggestions || '[]')
  if (!dismissed.includes(companyId)) {
    dismissed.push(companyId)
    db.prepare(
      `UPDATE partner_meeting_digests SET dismissed_suggestions=?, updated_at=? WHERE id=?`,
    ).run(JSON.stringify(dismissed), new Date().toISOString(), digestId)
  }
}

export function setDigestMeetingId(digestId: string, meetingId: string | null): void {
  const db = getDatabase()
  db.prepare(
    `UPDATE partner_meeting_digests SET meeting_id=?, updated_at=? WHERE id=?`,
  ).run(meetingId, new Date().toISOString(), digestId)
}
