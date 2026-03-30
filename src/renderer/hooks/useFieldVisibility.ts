import { usePreferencesStore } from '../stores/preferences.store'
import type { HardcodedFieldDef } from '../constants/contactFields'
import type { CustomFieldWithValue } from '../../shared/types/custom-fields'
import { CONTACT_SECTIONS, COMPANY_SECTIONS } from '../../shared/types/custom-fields'
import { resolveLayoutPref, saveLayoutPref } from '../utils/layoutPref'

/*
 * useFieldVisibility — shared field visibility + placement logic for both detail panels.
 *
 * Manages two prefs per entity type:
 *   cyggie:contact-added-fields (string[]) — explicitly added empty fields (template)
 *   cyggie:contact-field-placements (Record<string,string>) — hardcoded key → section override
 *
 * Three-tier read resolution (when opts.entityId provided):
 *   per-entity → per-profile-type → global → default
 *   (see src/renderer/utils/layoutPref.ts for key conventions)
 *
 * Visibility precedence:
 *   hiddenFields.includes(key) → false (hidden wins)
 *   hasValue → true
 *   (isEditing || showAllFields) && addedFields.includes(key) → true
 *   showAllFields → true
 *   else → false
 *
 * Placements: fieldPlacements[key] ?? hardcoded defaultSection ?? fallback section
 * Invalid stored sections are defensively ignored (fall back to defaultSection).
 */

/** Pure helpers — exported for unit testing */

export function computeShowField(
  key: string,
  value: unknown,
  hiddenFields: string[],
  addedFields: string[],
  isEditing: boolean,
  showAllFields: boolean,
): boolean {
  if (hiddenFields.includes(key)) return false
  const hasValue = Array.isArray(value)
    ? value.length > 0
    : (value !== null && value !== undefined && value !== '' && value !== '-' && value !== '—')
  if (hasValue) return true
  if ((isEditing || showAllFields) && addedFields.includes(key)) return true
  if (showAllFields) return true
  return false
}

export function computeGetFieldSection(
  key: string,
  fieldPlacements: Record<string, string>,
  defMap: Map<string, { defaultSection: string }>,
  validSections: Set<string>,
  entityType: 'contact' | 'company',
): string {
  const stored = fieldPlacements[key]
  if (stored && validSections.has(stored)) return stored
  return defMap.get(key)?.defaultSection ?? (entityType === 'contact' ? 'contact_info' : 'overview')
}

export function computeCleanupOnDone(addedFields: string[], emptyKeys: string[]): string[] {
  return addedFields.filter((k) => !emptyKeys.includes(k))
}

export interface UseFieldVisibilityReturn {
  addedFields: string[]
  fieldPlacements: Record<string, string>
  showField(key: string, value: unknown): boolean
  getFieldSection(key: string): string
  addToAddedFields(keys: string[]): void
  removeFromAddedFields(key: string): void
  setFieldPlacement(key: string, section: string): void
  cleanupOnDone(emptyKeys: string[]): void
  isCustomFieldVisible(field: CustomFieldWithValue, isEditing: boolean, showAll: boolean): boolean
}

export interface UseFieldVisibilityOpts {
  entityId?: string
  profileKey?: string | null
  onLayoutChange?: () => void
}

export function useFieldVisibility(
  entityType: 'contact' | 'company',
  hardcodedDefs: HardcodedFieldDef[],
  hiddenFields: string[],
  showAllFields: boolean,
  isEditing: boolean,
  opts?: UseFieldVisibilityOpts,
): UseFieldVisibilityReturn {
  const { getJSON, setJSON } = usePreferencesStore()
  const { entityId, profileKey, onLayoutChange } = opts ?? {}

  const addedFieldsKey = `cyggie:${entityType}-added-fields`
  const placementsKey = `cyggie:${entityType}-field-placements`

  const rawAddedFields = entityId
    ? resolveLayoutPref(getJSON, addedFieldsKey, entityId, profileKey ?? null, [] as unknown)
    : getJSON<unknown>(addedFieldsKey, [])
  const addedFields: string[] = Array.isArray(rawAddedFields) ? rawAddedFields as string[] : []

  const rawPlacements = entityId
    ? resolveLayoutPref(getJSON, placementsKey, entityId, profileKey ?? null, {} as unknown)
    : getJSON<unknown>(placementsKey, {})
  const fieldPlacements: Record<string, string> =
    rawPlacements && typeof rawPlacements === 'object' && !Array.isArray(rawPlacements)
      ? rawPlacements as Record<string, string>
      : {}

  // Build a Map for O(1) defaultSection lookups
  const defMap = new Map(hardcodedDefs.map((d) => [d.key, d]))

  // Valid section keys for this entity type
  const validSections = new Set(
    (entityType === 'contact' ? CONTACT_SECTIONS : COMPANY_SECTIONS).map((s) => s.key)
  )

  function showField(key: string, value: unknown): boolean {
    return computeShowField(key, value, hiddenFields, addedFields, isEditing, showAllFields)
  }

  function getFieldSection(key: string): string {
    return computeGetFieldSection(key, fieldPlacements, defMap, validSections, entityType)
  }

  function addToAddedFields(keys: string[]) {
    const next = [...new Set([...addedFields, ...keys])]
    if (entityId) {
      saveLayoutPref(setJSON, addedFieldsKey, entityId, next)
    } else {
      setJSON(addedFieldsKey, next)
    }
    onLayoutChange?.()
  }

  function removeFromAddedFields(key: string) {
    const next = addedFields.filter((k) => k !== key)
    if (entityId) {
      saveLayoutPref(setJSON, addedFieldsKey, entityId, next)
    } else {
      setJSON(addedFieldsKey, next)
    }
    onLayoutChange?.()
  }

  function setFieldPlacement(key: string, section: string) {
    const next = { ...fieldPlacements, [key]: section }
    if (entityId) {
      saveLayoutPref(setJSON, placementsKey, entityId, next)
    } else {
      setJSON(placementsKey, next)
    }
    onLayoutChange?.()
  }

  function cleanupOnDone(emptyKeys: string[]) {
    if (emptyKeys.length === 0) return
    const next = computeCleanupOnDone(addedFields, emptyKeys)
    // Write to per-entity key if available — but do NOT call onLayoutChange
    // (this is automatic cleanup on Done exit, not a user-initiated layout change)
    if (entityId) {
      saveLayoutPref(setJSON, addedFieldsKey, entityId, next)
    } else {
      setJSON(addedFieldsKey, next)
    }
  }

  function isCustomFieldVisible(
    field: CustomFieldWithValue,
    editing: boolean,
    showAll: boolean,
  ): boolean {
    const fieldKey = `custom:${field.id}`
    if (hiddenFields.includes(fieldKey)) return false
    const hasValue = field.value !== null && field.value !== undefined
    if (hasValue) return true
    if ((editing || showAll) && addedFields.includes(fieldKey)) return true
    if (showAll) return true
    return false
  }

  return {
    addedFields,
    fieldPlacements,
    showField,
    getFieldSection,
    addToAddedFields,
    removeFromAddedFields,
    setFieldPlacement,
    cleanupOnDone,
    isCustomFieldVisible,
  }
}
