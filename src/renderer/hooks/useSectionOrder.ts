import { useState } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'
import { computeEffectiveOrder } from './useHeaderChipOrder'
import { resolveLayoutPref, saveLayoutPref } from '../utils/layoutPref'

/*
 * useSectionOrder — manages drag-to-reorder for section headers in detail panels.
 *
 * Section order is stored per entity type:
 *   cyggie:contact-sections-order → string[]
 *   cyggie:company-sections-order → string[]
 *
 * When entityId is provided, reads/writes use three-tier resolution:
 *   per-entity → per-profile-type → global → []
 *   (see src/renderer/utils/layoutPref.ts for key conventions)
 *
 * The 'summary' section (Header chip row) is always excluded from ordering —
 * it is always rendered first above the field sections.
 *
 * Order derivation (same algorithm as useHeaderChipOrder):
 *   storedValid = stored ∩ allSectionKeys   (stale keys filtered)
 *   newSections = allSectionKeys \ storedValid  (unknown keys appended)
 *   effectiveOrder = [...storedValid, ...newSections]
 *
 * State machine per drag:
 *   idle → dragging (onDragStart) → hovering (onDragOver) → dropped (onDrop) → idle
 */

/** Pure reorder logic — exported for unit testing */
export function reorderSections(
  orderedSections: string[],
  fromKey: string,
  toKey: string,
): string[] | null {
  if (fromKey === toKey) return null
  const withoutFrom = orderedSections.filter((k) => k !== fromKey)
  const targetIdx = withoutFrom.findIndex((k) => k === toKey)
  if (targetIdx === -1) return null
  return [...withoutFrom.slice(0, targetIdx), fromKey, ...withoutFrom.slice(targetIdx)]
}

export function useSectionOrder(
  entityType: 'contact' | 'company',
  allSectionKeys: string[],
  entityId?: string,
  profileKey?: string | null,
  onLayoutChange?: () => void,
) {
  const { getJSON, setJSON } = usePreferencesStore()
  const [draggingSectionKey, setDraggingSectionKey] = useState<string | null>(null)
  const [dragOverSectionKey, setDragOverSectionKey] = useState<string | null>(null)

  const storageKey = `cyggie:${entityType}-sections-order`

  // Exclude 'summary' from ordering — Header chip row is always first
  const orderableSections = allSectionKeys.filter((k) => k !== 'summary')

  const stored = entityId
    ? resolveLayoutPref(getJSON, storageKey, entityId, profileKey ?? null, [] as string[])
    : getJSON<string[]>(storageKey, [])
  const orderedSections = computeEffectiveOrder(stored, orderableSections)

  function reorder(fromKey: string, toKey: string) {
    const next = reorderSections(orderedSections, fromKey, toKey)
    if (!next) return
    if (entityId) {
      saveLayoutPref(setJSON, storageKey, entityId, next)
    } else {
      setJSON(storageKey, next)
    }
    onLayoutChange?.()
  }

  return {
    orderedSections,
    draggingSectionKey,
    setDraggingSectionKey,
    dragOverSectionKey,
    setDragOverSectionKey,
    reorder,
  }
}
