// =============================================================================
// target-stage-consolidation-backfill.service.ts — one-shot merge of the
// orphaned custom "Target Stage" / "Focus" fields into the canonical built-in
// "Target Investment Stage" field, then delete the orphans.
//
// History: a prior PR added the built-in "Target Investment Stage" field
// (org_companies.target_investment_stage / contacts.investment_stage_focus,
// the same term contacts use) but never removed the pre-consolidation custom
// fields. Result: three overlapping stage fields. This backfill completes the
// consolidation.
//
//   custom_field_values (orphan defs)  ─┐
//   org_companies.target_investment     ├─ mergeStageValues() ─ updateCompany ─► outbox ─► Neon
//             _stage (existing)         ┘  (parse JSON|comma,    (withSync)
//   contacts.investment_stage_focus  ───── dedup, canonical ──── updateContact ─► outbox ─► Neon
//                                          order, drop bogus)
//   delete orphan defs (is_builtin=0, field_key IN focus/target_stage)
//     ─ deleteFieldDefinition (withSync → tombstone; FK cascades to values)
//
// Orphans are matched by (entity_type, field_key, is_builtin=0) rather than
// hardcoded ids so this is portable across installs. Runs through the wrapped
// barrel writers so every change reaches Neon via the outbox.
//
// Gated on userId (like the sync backfills) so writes actually emit — running
// it logged-out would delete the orphans locally with no tombstone, stranding
// Neon. Naturally idempotent WITHOUT a settings guard: once the orphan defs are
// deleted, a re-run finds nothing to do.
//
// Ordering: launched BEFORE custom-field-sync-backfill so the orphan defs are
// gone before that backfill enqueues the surviving custom fields.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { updateCompany, updateContact, deleteFieldDefinition } from '@cyggie/db/sqlite/repositories'
import { mergeStageValues } from '../../shared/custom-field-values'

// Orphan custom fields to fold into the built-in field, by field_key.
const COMPANY_ORPHAN_KEYS = ['focus', 'target_stage'] as const
const CONTACT_ORPHAN_KEYS = ['target_stage'] as const

export interface ConsolidationResult {
  companiesUpdated: number
  contactsUpdated: number
  definitionsDeleted: number
}

interface OrphanDef {
  id: string
  entity_type: string
  field_key: string
}

/**
 * Merge orphaned company/contact stage custom fields into the built-in native
 * columns, then delete the orphan definitions. Early-returns when userId is
 * null (writes wouldn't emit to the outbox).
 */
export function consolidateTargetStageFields(userId: string | null): ConsolidationResult {
  const empty: ConsolidationResult = { companiesUpdated: 0, contactsUpdated: 0, definitionsDeleted: 0 }
  if (!userId) {
    console.log('[target-stage-consolidation] skipped: no user_id at launch')
    return empty
  }
  const db = getDatabase()

  const orphans = db
    .prepare(
      `SELECT id, entity_type, field_key FROM custom_field_definitions
       WHERE is_builtin = 0 AND (
         (entity_type = 'company' AND field_key IN ('focus', 'target_stage')) OR
         (entity_type = 'contact' AND field_key IN ('target_stage'))
       )`,
    )
    .all() as OrphanDef[]
  if (orphans.length === 0) return empty // already consolidated

  const companyDefIds = orphans.filter((d) => d.entity_type === 'company').map((d) => d.id)
  const contactDefIds = orphans.filter((d) => d.entity_type === 'contact').map((d) => d.id)

  const companiesUpdated = mergeEntity(
    db,
    companyDefIds,
    'org_companies',
    'target_investment_stage',
    (id, merged) => updateCompany(id, { targetInvestmentStage: merged }),
  )
  const contactsUpdated = mergeEntity(
    db,
    contactDefIds,
    'contacts',
    'investment_stage_focus',
    (id, merged) => updateContact(id, { investmentStageFocus: merged }),
  )

  // Delete the orphan definitions (FK cascade removes their values locally; the
  // wrapped delete emits a tombstone so Neon's ON DELETE CASCADE clears values).
  let definitionsDeleted = 0
  for (const d of orphans) {
    try {
      if (deleteFieldDefinition(d.id)) definitionsDeleted++
    } catch (err) {
      console.error(`[target-stage-consolidation] failed to delete def ${d.id}:`, err)
    }
  }

  console.log(
    `[target-stage-consolidation] companies=${companiesUpdated} contacts=${contactsUpdated} defsDeleted=${definitionsDeleted}`,
  )
  return { companiesUpdated, contactsUpdated, definitionsDeleted }
}

/**
 * For every entity that has a value in any of `defIds`, merge those values with
 * the existing native-column value and write the canonical result back via the
 * wrapped writer. Returns the number of entities actually updated.
 */
function mergeEntity(
  db: import('better-sqlite3').Database,
  defIds: string[],
  table: 'org_companies' | 'contacts',
  column: 'target_investment_stage' | 'investment_stage_focus',
  write: (entityId: string, merged: string) => unknown,
): number {
  if (defIds.length === 0) return 0
  const placeholders = defIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT entity_id, value_text FROM custom_field_values
       WHERE field_definition_id IN (${placeholders})
         AND value_text IS NOT NULL AND value_text <> ''`,
    )
    .all(...defIds) as Array<{ entity_id: string; value_text: string }>

  const byEntity = new Map<string, string[]>()
  for (const r of rows) {
    const list = byEntity.get(r.entity_id) ?? []
    list.push(r.value_text)
    byEntity.set(r.entity_id, list)
  }

  let updated = 0
  for (const [entityId, rawVals] of byEntity) {
    const existingRow = db
      .prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`)
      .get(entityId) as { v: string | null } | undefined
    if (!existingRow) continue // entity gone (stale value row)
    const merged = mergeStageValues(existingRow.v, ...rawVals)
    // Skip when the merge is a no-op (existing already canonical + complete).
    if (!merged || merged === mergeStageValues(existingRow.v)) continue
    try {
      write(entityId, merged)
      updated++
    } catch (err) {
      console.error(`[target-stage-consolidation] failed to update ${table} ${entityId}:`, err)
    }
  }
  return updated
}

/**
 * Fire-and-forget launcher. Defers 3s (same as memo-sync-backfill) so it runs
 * after sync bootstrap but BEFORE custom-field-sync-backfill (3.5s).
 */
export function consolidateTargetStageFieldsOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      consolidateTargetStageFields(userId)
    } catch (err) {
      console.error('[target-stage-consolidation] unexpected failure:', err)
    }
  }, 3000)
}
