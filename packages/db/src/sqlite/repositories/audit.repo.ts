import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'

export type AuditAction = 'create' | 'update' | 'delete' | 'stage_change' | 'set_group_event'

/**
 * Append a row to `audit_log`.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Audit log is observability data, NOT load-bearing for callers.  │
 *   │                                                                   │
 *   │  audit_log has FK: user_id REFERENCES users(id) ON DELETE SET     │
 *   │  NULL. If a caller passes a userId that isn't in users (stale     │
 *   │  cache, deleted row), the INSERT fires SQLITE_CONSTRAINT_FOREIGN  │
 *   │  KEY. Pre-safety-net behavior: that exception bubbled up to the   │
 *   │  caller, killing operations whose audit-log write was the last    │
 *   │  step — most notably the stress-test success branch, where a      │
 *   │  failed logAudit would lose the persisted report.                 │
 *   │                                                                   │
 *   │  Safety net: FK violations are demoted to console.warn and the    │
 *   │  call returns. The transactional work the caller did (the actual  │
 *   │  domain write) survives. Other exceptions still throw.            │
 *   └──────────────────────────────────────────────────────────────────┘
 */
export function logAudit(
  userId: string | null,
  entityType: string,
  entityId: string,
  action: AuditAction,
  changes: unknown = null
): void {
  const db = getDatabase()
  try {
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
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
      console.warn('[audit] dropped row (FK violation):', { userId, entityType, entityId, action, message: err.message })
      return
    }
    throw err
  }
}

export function logAppEvent(
  userId: string | null,
  eventName: string,
  properties: Record<string, unknown> | null = null
): void {
  const db = getDatabase()
  try {
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
  } catch (err) {
    if (err instanceof Error && /FOREIGN KEY/i.test(err.message)) {
      console.warn('[app_events] dropped row (FK violation):', { userId, eventName, message: err.message })
      return
    }
    throw err
  }
}
