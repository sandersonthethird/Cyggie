// Recycle bin (Phase 3 multiplayer soft-delete) — shared types + retention.

/**
 * Days a soft-deleted row is recoverable before it's eligible for hard purge.
 * The gateway has its OWN copy (api-gateway/src/routes/sync.ts) because it can't
 * import the desktop's src/shared across the build boundary — KEEP THEM IN SYNC.
 */
export const RECYCLE_RETENTION_DAYS = 30

/** A trashed company or task shown in the Recycle Bin. */
export interface DeletedEntitySummary {
  id: string
  entityType: 'company' | 'task'
  /** Display name (company canonical_name / task title). */
  label: string
  /** Secondary line (company domain / task company-or-meeting context). */
  sublabel: string | null
  /** ISO timestamp the row was soft-deleted. */
  deletedAt: string
  /** Display name of who deleted it, or null if not resolvable locally yet. */
  deletedByName: string | null
  /** ISO timestamp it becomes eligible for hard purge (deletedAt + retention). */
  purgesAt: string
}

/**
 * Add N days to an ISO/SQLite datetime string, returning an ISO string.
 * Tolerant of SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no zone) by treating a
 * space-separated value as UTC. Returns the input unchanged if unparseable.
 */
export function addDays(iso: string, days: number): string {
  const normalized = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z'
  const t = Date.parse(normalized)
  if (Number.isNaN(t)) return iso
  return new Date(t + days * 24 * 60 * 60 * 1000).toISOString()
}
