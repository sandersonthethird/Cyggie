import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'

export type AuditAction = 'create' | 'update' | 'delete' | 'stage_change'

export function logAudit(
  userId: string | null,
  entityType: string,
  entityId: string,
  action: AuditAction,
  changes: unknown = null
): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO audit_log (
      id, user_id, entity_type, entity_id, action, changes_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    randomUUID(),
    userId,
    entityType,
    entityId,
    action,
    changes == null ? null : JSON.stringify(changes)
  )
}

export function logAppEvent(
  userId: string | null,
  eventName: string,
  properties: Record<string, unknown> | null = null
): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO app_events (
      id, user_id, event_name, properties_json, created_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
  `).run(
    randomUUID(),
    userId,
    eventName,
    properties ? JSON.stringify(properties) : null
  )
}
