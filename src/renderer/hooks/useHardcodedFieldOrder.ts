import { useState } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'
import { computeEffectiveOrder } from './useHeaderChipOrder'

/*
 * useHardcodedFieldOrder — manages drag-to-reorder for hardcoded (built-in) field rows
 * within a section in detail panel edit mode.
 *
 * Ordering is persisted per entity type + section in preferences:
 *   cyggie:<entityKey>-section-order:<sectionKey> → string[]  (ordered field keys)
 *
 * Order derivation (same algorithm as useHeaderChipOrder):
 *   storedValid = stored ∩ fieldKeys   (stale keys filtered)
 *   newFields   = fieldKeys \ storedValid  (unknown keys appended)
 *   effectiveOrder = [...storedValid, ...newFields]
 *
 * State machine per drag:
 *   idle → dragging (onDragStart) → hovering (onDragOver) → dropped (onDrop) → idle
 */

export function useHardcodedFieldOrder(entityKey: 'contact' | 'company') {
  const { getJSON, setJSON } = usePreferencesStore()
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [draggingOverKey, setDraggingOverKey] = useState<string | null>(null)

  function storageKey(sectionKey: string) {
    return `cyggie:${entityKey}-section-order:${sectionKey}`
  }

  /** Apply stored ordering to a set of fields. New/unknown keys are appended. */
  function applyOrder<T extends { key: string }>(fields: T[], sectionKey: string): T[] {
    const stored = getJSON<string[]>(storageKey(sectionKey), [])
    const ordered = computeEffectiveOrder(stored, fields.map((f) => f.key))
    return ordered.map((key) => fields.find((f) => f.key === key)!).filter(Boolean)
  }

  /** Reorder: move dragging field to just before target field within a section. */
  function reorder(sectionKey: string, fromKey: string, toKey: string, allKeys: string[]) {
    if (fromKey === toKey) return
    const stored = getJSON<string[]>(storageKey(sectionKey), [])
    const effective = computeEffectiveOrder(stored, allKeys)
    const withoutFrom = effective.filter((k) => k !== fromKey)
    const targetIdx = withoutFrom.findIndex((k) => k === toKey)
    if (targetIdx === -1) return
    const next = [...withoutFrom.slice(0, targetIdx), fromKey, ...withoutFrom.slice(targetIdx)]
    setJSON(storageKey(sectionKey), next)
  }

  return {
    draggingKey,
    setDraggingKey,
    draggingOverKey,
    setDraggingOverKey,
    applyOrder,
    reorder,
  }
}
