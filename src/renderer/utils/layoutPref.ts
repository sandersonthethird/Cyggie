/*
 * layoutPref — three-tier layout preference resolution for detail panels.
 *
 * Read order:
 *   Per-entity  →  Per-profile-type  →  Global (existing key)  →  Hardcoded default
 *   :entity:{id}   :entity:{type}       {baseKey}                []
 *
 * Write order:
 *   Always write to per-entity key (entity:{id}).
 *   On "Apply to all": propagate per-entity → profile-type key (or global for contacts).
 *   On "Reset": null out per-entity key → falls back to profile-type or global.
 *
 * Key convention example (company chip order):
 *   cyggie:company-header-chip-order                    ← global
 *   cyggie:company-header-chip-order:entity:vc_fund     ← entity-type template
 *   cyggie:company-header-chip-order:entity:abc123      ← per-company override
 *
 * For contacts (no sub-type), profileKey is null:
 *   cyggie:contact-header-chip-order                    ← global (also "Apply to all" target)
 *   cyggie:contact-header-chip-order:entity:cid123      ← per-contact override
 */

// Matches the actual usePreferencesStore signature: getJSON<T>(key, defaultValue: T): T
type GetJsonFn = <U>(key: string, defaultValue: U) => U
type SetJsonFn = (key: string, value: unknown) => void

/**
 * Three-tier read. Returns the first non-null value found:
 *   1. Per-entity key  (`${baseKey}:entity:${entityId}`)
 *   2. Per-profile key (`${baseKey}:entity:${profileKey}`)  — skipped when profileKey is null
 *   3. Global key      (`${baseKey}`)
 *   4. `defaultValue`
 */
export function resolveLayoutPref<T>(
  getJSON: GetJsonFn,
  baseKey: string,
  entityId: string,
  profileKey: string | null,
  defaultValue: T,
): T {
  return (
    getJSON<T | null>(`${baseKey}:entity:${entityId}`, null)
    ?? (profileKey ? getJSON<T | null>(`${baseKey}:entity:${profileKey}`, null) : null)
    ?? getJSON<T | null>(baseKey, null)
    ?? defaultValue
  )
}

/**
 * Write always to the per-entity key (`${baseKey}:entity:${entityId}`).
 */
export function saveLayoutPref(
  setJSON: SetJsonFn,
  baseKey: string,
  entityId: string,
  value: unknown,
): void {
  setJSON(`${baseKey}:entity:${entityId}`, value)
}

/**
 * Propagate the per-entity value up to a shared template key:
 *   - non-null profileKey → `${baseKey}:entity:${profileKey}` (company entity-type template)
 *   - null profileKey     → `${baseKey}` (global contact template — "Apply to all contacts")
 *
 * No-ops if the per-entity key is null (nothing to propagate).
 */
export function propagateLayoutPref(
  getJSON: GetJsonFn,
  setJSON: SetJsonFn,
  baseKey: string,
  entityId: string,
  profileKey: string | null,
): void {
  const value = getJSON<unknown>(`${baseKey}:entity:${entityId}`, null)
  if (value !== null) {
    const targetKey = profileKey ? `${baseKey}:entity:${profileKey}` : baseKey
    setJSON(targetKey, value)
  }
}

/**
 * Clear the per-entity override — subsequent reads fall through to the
 * entity-type template or global default.
 */
export function clearPerEntityPref(
  setJSON: SetJsonFn,
  baseKey: string,
  entityId: string,
): void {
  setJSON(`${baseKey}:entity:${entityId}`, null)
}

/**
 * One-time migration: rename legacy `:company:{id}` per-entity keys → `:entity:{id}`.
 *
 * Prior to this migration, saveLayoutPref() wrote keys like:
 *   cyggie:contact-added-fields:company:cid123
 * The `:company:` suffix was used for both company and contact entities, which was
 * confusing. This migration renames all such keys to use `:entity:` instead.
 *
 * Uses a guard flag so it only runs once per device.
 * Wrapped in try/catch to handle SecurityError in restricted localStorage contexts.
 */
export function migratePerEntityKeyNames(): void {
  const MIGRATION_FLAG = 'cyggie:layout-pref-migration-v1'
  try {
    if (localStorage.getItem(MIGRATION_FLAG)) return
    for (const key of Object.keys(localStorage)) {
      // Match only the per-entity suffix (last :company:{id} segment), not base key
      // names like cyggie:company-added-fields which contain "-company-" not ":company:"
      const migrated = key.replace(/:company:([^:]+)$/, ':entity:$1')
      if (migrated !== key) {
        const val = localStorage.getItem(key)
        if (val !== null) localStorage.setItem(migrated, val)
        localStorage.removeItem(key)
      }
    }
    localStorage.setItem(MIGRATION_FLAG, '1')
  } catch {
    // Silent — fall through and re-attempt on next launch (SecurityError in restricted contexts)
  }
}
