import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type {
  CompanyDecisionLog,
  DecisionNextStep,
  DecisionLinkedArtifact
} from '../../../shared/types/company'

interface DecisionLogRow {
  id: string
  company_id: string
  decision_type: string
  decision_date: string
  decision_owner: string | null
  amount_approved: string | null
  target_ownership: string | null
  more_if_possible: number
  structure: string | null
  rationale_json: string
  dependencies_json: string
  next_steps_json: string
  linked_artifacts_json: string
  created_at: string
  updated_at: string
}

export function safeParseArray(s: string): unknown[] {
  try {
    const parsed = JSON.parse(s)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function rowToDecisionLog(row: DecisionLogRow): CompanyDecisionLog {
  return {
    id: row.id,
    companyId: row.company_id,
    decisionType: row.decision_type,
    decisionDate: row.decision_date,
    decisionOwner: row.decision_owner,
    amountApproved: row.amount_approved,
    targetOwnership: row.target_ownership,
    moreIfPossible: row.more_if_possible === 1,
    structure: row.structure,
    rationale: safeParseArray(row.rationale_json) as string[],
    dependencies: safeParseArray(row.dependencies_json) as string[],
    nextSteps: safeParseArray(row.next_steps_json) as DecisionNextStep[],
    linkedArtifacts: safeParseArray(row.linked_artifacts_json) as DecisionLinkedArtifact[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const SYNC_DECISION_TYPES = new Set([
  'Investment Approved',
  'Increase Allocation',
  'Follow-on'
])

function syncPortfolioFields(
  db: ReturnType<typeof getDatabase>,
  companyId: string,
  data: { amountApproved?: string | null; targetOwnership?: string | null }
): void {
  const sets: string[] = []
  const params: unknown[] = []

  if (data.amountApproved != null && data.amountApproved !== '') {
    sets.push('investment_size = ?')
    params.push(data.amountApproved)
  }
  if (data.targetOwnership != null && data.targetOwnership !== '') {
    sets.push('ownership_pct = ?')
    params.push(data.targetOwnership)
  }

  if (sets.length === 0) return

  sets.push("updated_at = datetime('now')")
  params.push(companyId)
  db.prepare(`UPDATE org_companies SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function listCompanyDecisionLogs(companyId: string): CompanyDecisionLog[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, company_id, decision_type, decision_date, decision_owner,
             amount_approved, target_ownership, more_if_possible, structure,
             rationale_json, dependencies_json, next_steps_json, linked_artifacts_json,
             created_at, updated_at
      FROM company_decision_logs
      WHERE company_id = ?
      ORDER BY decision_date DESC, created_at DESC
    `)
    .all(companyId) as DecisionLogRow[]
  return rows.map(rowToDecisionLog)
}

export function getCompanyDecisionLog(logId: string): CompanyDecisionLog | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, company_id, decision_type, decision_date, decision_owner,
             amount_approved, target_ownership, more_if_possible, structure,
             rationale_json, dependencies_json, next_steps_json, linked_artifacts_json,
             created_at, updated_at
      FROM company_decision_logs
      WHERE id = ?
    `)
    .get(logId) as DecisionLogRow | undefined
  return row ? rowToDecisionLog(row) : null
}

export function getLatestCompanyDecisionLog(companyId: string): CompanyDecisionLog | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, company_id, decision_type, decision_date, decision_owner,
             amount_approved, target_ownership, more_if_possible, structure,
             rationale_json, dependencies_json, next_steps_json, linked_artifacts_json,
             created_at, updated_at
      FROM company_decision_logs
      WHERE company_id = ?
      ORDER BY decision_date DESC, created_at DESC
      LIMIT 1
    `)
    .get(companyId) as DecisionLogRow | undefined
  return row ? rowToDecisionLog(row) : null
}

export function createCompanyDecisionLog(
  data: {
    companyId: string
    decisionType: string
    decisionDate: string
    decisionOwner?: string | null
    amountApproved?: string | null
    targetOwnership?: string | null
    moreIfPossible?: boolean
    structure?: string | null
    rationale?: string[]
    dependencies?: string[]
    nextSteps?: DecisionNextStep[]
    linkedArtifacts?: DecisionLinkedArtifact[]
  },
  userId: string | null = null
): CompanyDecisionLog {
  const db = getDatabase()
  const id = randomUUID()

  db.prepare(`
    INSERT INTO company_decision_logs (
      id, company_id, decision_type, decision_date, decision_owner,
      amount_approved, target_ownership, more_if_possible, structure,
      rationale_json, dependencies_json, next_steps_json, linked_artifacts_json,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.companyId,
    data.decisionType,
    data.decisionDate,
    data.decisionOwner ?? null,
    data.amountApproved ?? null,
    data.targetOwnership ?? null,
    data.moreIfPossible ? 1 : 0,
    data.structure ?? null,
    JSON.stringify(data.rationale ?? []),
    JSON.stringify(data.dependencies ?? []),
    JSON.stringify(data.nextSteps ?? []),
    JSON.stringify(data.linkedArtifacts ?? []),
    userId,
    userId
  )

  // Auto-sync deal terms to company portfolio fields for investment-type decisions
  if (SYNC_DECISION_TYPES.has(data.decisionType)) {
    syncPortfolioFields(db, data.companyId, {
      amountApproved: data.amountApproved,
      targetOwnership: data.targetOwnership
    })
  }

  return getCompanyDecisionLog(id)!
}

const ALLOWED_UPDATE_KEYS = new Set([
  'decisionType',
  'decisionDate',
  'decisionOwner',
  'amountApproved',
  'targetOwnership',
  'moreIfPossible',
  'structure',
  'rationale',
  'dependencies',
  'nextSteps',
  'linkedArtifacts'
])

const CAMEL_TO_COLUMN: Record<string, string> = {
  decisionType: 'decision_type',
  decisionDate: 'decision_date',
  decisionOwner: 'decision_owner',
  amountApproved: 'amount_approved',
  targetOwnership: 'target_ownership',
  moreIfPossible: 'more_if_possible',
  structure: 'structure',
  rationale: 'rationale_json',
  dependencies: 'dependencies_json',
  nextSteps: 'next_steps_json',
  linkedArtifacts: 'linked_artifacts_json'
}

export function updateCompanyDecisionLog(
  logId: string,
  data: Partial<Omit<CompanyDecisionLog, 'id' | 'companyId' | 'createdAt' | 'updatedAt'>>,
  userId: string | null = null
): CompanyDecisionLog | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_UPDATE_KEYS.has(key)) throw new Error(`Unknown update key: ${key}`)
    const col = CAMEL_TO_COLUMN[key]
    if (!col) continue

    if (key === 'moreIfPossible') {
      sets.push(`${col} = ?`)
      params.push(value ? 1 : 0)
    } else if (key === 'rationale' || key === 'dependencies' || key === 'nextSteps' || key === 'linkedArtifacts') {
      sets.push(`${col} = ?`)
      params.push(JSON.stringify(value ?? []))
    } else {
      sets.push(`${col} = ?`)
      params.push(value ?? null)
    }
  }

  if (sets.length === 0) return getCompanyDecisionLog(logId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(logId)

  db.prepare(`UPDATE company_decision_logs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getCompanyDecisionLog(logId)
}

export function deleteCompanyDecisionLog(logId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM company_decision_logs WHERE id = ?').run(logId)
  return result.changes > 0
}
