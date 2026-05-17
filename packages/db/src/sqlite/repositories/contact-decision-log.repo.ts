import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import { safeParseArray } from './company-decision-log.repo'
import type { ContactDecisionLog } from '../../../shared/types/contact'
import type { DecisionNextStep } from '../../../shared/types/company'

interface ContactDecisionLogRow {
  id: string
  contact_id: string
  decision_type: string
  decision_date: string
  decision_owner: string | null
  rationale_json: string
  next_steps_json: string
  created_at: string
  updated_at: string
}

function rowToContactDecisionLog(row: ContactDecisionLogRow): ContactDecisionLog {
  return {
    id: row.id,
    contactId: row.contact_id,
    decisionType: row.decision_type,
    decisionDate: row.decision_date,
    decisionOwner: row.decision_owner,
    rationale: safeParseArray(row.rationale_json) as string[],
    nextSteps: safeParseArray(row.next_steps_json) as DecisionNextStep[],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listContactDecisionLogs(contactId: string): ContactDecisionLog[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, contact_id, decision_type, decision_date, decision_owner,
             rationale_json, next_steps_json, created_at, updated_at
      FROM contact_decision_logs
      WHERE contact_id = ?
      ORDER BY decision_date DESC, created_at DESC
      LIMIT 200
    `)
    .all(contactId) as ContactDecisionLogRow[]
  return rows.map(rowToContactDecisionLog)
}

export function getContactDecisionLog(logId: string): ContactDecisionLog | null {
  const db = getDatabase()
  const row = db
    .prepare(`
      SELECT id, contact_id, decision_type, decision_date, decision_owner,
             rationale_json, next_steps_json, created_at, updated_at
      FROM contact_decision_logs
      WHERE id = ?
    `)
    .get(logId) as ContactDecisionLogRow | undefined
  return row ? rowToContactDecisionLog(row) : null
}

export function createContactDecisionLog(
  data: {
    contactId: string
    decisionType: string
    decisionDate: string
    decisionOwner?: string | null
    rationale?: string[]
    nextSteps?: DecisionNextStep[]
  },
  userId: string | null = null
): ContactDecisionLog {
  const db = getDatabase()
  const id = randomUUID()

  db.prepare(`
    INSERT INTO contact_decision_logs (
      id, contact_id, decision_type, decision_date, decision_owner,
      rationale_json, next_steps_json,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    id,
    data.contactId,
    data.decisionType,
    data.decisionDate,
    data.decisionOwner ?? null,
    JSON.stringify(data.rationale ?? []),
    JSON.stringify(data.nextSteps ?? []),
    userId,
    userId
  )

  return getContactDecisionLog(id)!
}

const ALLOWED_UPDATE_KEYS = new Set([
  'decisionType', 'decisionDate', 'decisionOwner', 'rationale', 'nextSteps'
])

const CAMEL_TO_COLUMN: Record<string, string> = {
  decisionType: 'decision_type',
  decisionDate: 'decision_date',
  decisionOwner: 'decision_owner',
  rationale: 'rationale_json',
  nextSteps: 'next_steps_json'
}

export function updateContactDecisionLog(
  logId: string,
  data: Partial<Omit<ContactDecisionLog, 'id' | 'contactId' | 'createdAt' | 'updatedAt'>>,
  userId: string | null = null
): ContactDecisionLog | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_UPDATE_KEYS.has(key)) throw new Error(`Unknown update key: ${key}`)
    const col = CAMEL_TO_COLUMN[key]
    if (!col) continue

    if (key === 'rationale' || key === 'nextSteps') {
      sets.push(`${col} = ?`)
      params.push(JSON.stringify(value ?? []))
    } else {
      sets.push(`${col} = ?`)
      params.push(value ?? null)
    }
  }

  if (sets.length === 0) return getContactDecisionLog(logId)

  if (userId) {
    sets.push('updated_by_user_id = ?')
    params.push(userId)
  }
  sets.push("updated_at = datetime('now')")
  params.push(logId)

  db.prepare(`UPDATE contact_decision_logs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getContactDecisionLog(logId)
}

export function deleteContactDecisionLog(logId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM contact_decision_logs WHERE id = ?').run(logId)
  return result.changes > 0
}
