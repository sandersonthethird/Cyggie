import { useMemo, useState } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'
import { resolveLayoutPref, saveLayoutPref } from '../utils/layoutPref'

/*
 * useHeaderChipOrder — manages drag-to-reorder for header chips in detail panels.
 *
 * Effective order is derived at render time (no migration needed):
 *   storedValid = stored ∩ allChipIds   (stale IDs filtered out)
 *   newChips    = allChipIds \ storedValid  (unknown IDs appended to end)
 *   effectiveOrder = [...storedValid, ...newChips]
 *
 * When entityId is provided, reads/writes use three-tier resolution:
 *   per-entity → per-profile-type → global → []
 *   (see src/renderer/utils/layoutPref.ts for key conventions)
 *
 * State machine per drag:
 *   idle → dragging (onDragStart) → hovering (onDragOver) → dropped (onDrop) → idle
 *   idle ← cancelled (onDragEnd without drop)
 */

/** Pure helper — exported for testing */
export function computeEffectiveOrder(chipOrder: string[], allChipIds: string[]): string[] {
  const storedValid = chipOrder.filter(id => allChipIds.includes(id))
  const newChips = allChipIds.filter(id => !storedValid.includes(id))
  return [...storedValid, ...newChips]
}

/** Pure helper — exported for testing */
export function applyReorder(effectiveOrder: string[], fromId: string, toIndex: number): string[] | null {
  if (effectiveOrder[toIndex] === fromId) return null // no-op self-drop
  const next = effectiveOrder.filter(id => id !== fromId)
  next.splice(toIndex, 0, fromId)
  return next
}

export function useHeaderChipOrder(
  entityKey: 'company' | 'contact',
  allChipIds: string[],
  entityId?: string,
  profileKey?: string | null,
  onLayoutChange?: () => void,
) {
  const { getJSON, setJSON } = usePreferencesStore()
  const storageKey = `cyggie:${entityKey}-header-chip-order`

  const chipOrder = entityId
    ? resolveLayoutPref(getJSON, storageKey, entityId, profileKey ?? null, [] as string[])
    : getJSON<string[]>(storageKey, [])

  const [draggingChipId, setDraggingChipId] = useState<string | null>(null)
  const [chipDragOverIndex, setChipDragOverIndex] = useState<number | null>(null)

  // Merge stored order with current chip IDs — filter stale, append new
  const effectiveOrder = useMemo(
    () => computeEffectiveOrder(chipOrder, allChipIds),
    [chipOrder, allChipIds], // eslint-disable-line react-hooks/exhaustive-deps
  )

  function reorderChip(fromId: string, toIndex: number) {
    const next = applyReorder(effectiveOrder, fromId, toIndex)
    if (!next) return
    if (entityId) {
      saveLayoutPref(setJSON, storageKey, entityId, next)
    } else {
      setJSON(storageKey, next)
    }
    onLayoutChange?.()
  }

  function chipDragProps(chipId: string): React.HTMLAttributes<HTMLElement> {
    return {
      draggable: true,
      onDragStart: () => setDraggingChipId(chipId),
      onDragEnd: () => {
        setDraggingChipId(null)
        setChipDragOverIndex(null)
      },
    }
  }

  function chipDropZoneProps(index: number): React.HTMLAttributes<HTMLElement> {
    return {
      onDragOver: (e) => { e.preventDefault(); setChipDragOverIndex(index) },
      onDragLeave: () => setChipDragOverIndex(null),
      onDrop: () => {
        if (draggingChipId) reorderChip(draggingChipId, index)
        setDraggingChipId(null)
        setChipDragOverIndex(null)
      },
    }
  }

  return {
    effectiveOrder,
    draggingChipId,
    chipDragOverIndex,
    chipDragProps,
    chipDropZoneProps,
  }
}
