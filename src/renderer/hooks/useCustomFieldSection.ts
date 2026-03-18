import { useRef, useState } from 'react'
import type { CustomFieldEntityType, CustomFieldWithValue } from '../../shared/types/custom-fields'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

/** Pure helper: reorder fields within a section by moving draggingId to just before targetId. */
export function computeWithinSectionReorder<T extends { id: string }>(
  sectionFields: T[],
  draggingId: string,
  targetId: string
): T[] | null {
  if (draggingId === targetId) return null
  const dragField = sectionFields.find((f) => f.id === draggingId)
  if (!dragField) return null
  const withoutDrag = sectionFields.filter((f) => f.id !== draggingId)
  const targetIdx = withoutDrag.findIndex((f) => f.id === targetId)
  if (targetIdx === -1) return null
  return [...withoutDrag.slice(0, targetIdx), dragField, ...withoutDrag.slice(targetIdx)]
}

export function useCustomFieldSection(
  _entityType: CustomFieldEntityType,
  _entityId: string,
  customFields: CustomFieldWithValue[],
  setCustomFields: React.Dispatch<React.SetStateAction<CustomFieldWithValue[]>>
) {
  const [draggingFieldId, setDraggingFieldId] = useState<string | null>(null)
  const [dragOverSection, setDragOverSection] = useState<string | null>(null)
  // Tracks which field the dragged item is hovering over (for within-section reorder)
  const [draggingOverFieldId, setDraggingOverFieldId] = useState<string | null>(null)
  // Counter per section to handle onDragLeave firing when entering child elements
  const dragCounters = useRef<Record<string, number>>({})

  function sectionedFields(section: string): CustomFieldWithValue[] {
    return customFields.filter((f) => f.section === section)
  }

  function nullSectionFields(): CustomFieldWithValue[] {
    return customFields.filter((f) => f.section === null || f.section === '')
  }

  // Cross-section move: update a field's section property
  async function handleFieldDrop(targetSection: string | null) {
    if (!draggingFieldId) return
    const fieldId = draggingFieldId
    const prev = customFields
    // Optimistic update
    setCustomFields((fs) => fs.map((f) => (f.id === fieldId ? { ...f, section: targetSection } : f)))
    try {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, fieldId, { section: targetSection })
    } catch {
      // Revert on failure
      setCustomFields(prev)
    }
  }

  // Within-section reorder: move draggingFieldId to the position of targetFieldId
  async function handleWithinSectionDrop(targetFieldId: string) {
    if (!draggingFieldId || draggingFieldId === targetFieldId) return
    setDraggingOverFieldId(null)

    // Find the section these fields share
    const dragField = customFields.find((f) => f.id === draggingFieldId)
    const targetField = customFields.find((f) => f.id === targetFieldId)
    if (!dragField || !targetField || dragField.section !== targetField.section) return

    const sectionKey = dragField.section
    const sectionFields = customFields.filter((f) => f.section === sectionKey)

    const reordered = computeWithinSectionReorder(sectionFields, draggingFieldId, targetFieldId)
    if (!reordered) return

    const orderedIds = reordered.map((f) => f.id)
    const prev = customFields

    // Optimistic update: apply the new order in local state
    setCustomFields((fs) => {
      const sectionSet = new Set(orderedIds)
      const others = fs.filter((f) => !sectionSet.has(f.id))
      return [...others, ...reordered]
    })

    try {
      await api.invoke(IPC_CHANNELS.CUSTOM_FIELD_REORDER_DEFINITIONS, orderedIds)
    } catch {
      setCustomFields(prev)
    }
  }

  function sectionDragProps(sectionName: string): React.HTMLAttributes<HTMLDivElement> {
    return {
      onDragOver: (e) => e.preventDefault(),
      onDragEnter: () => {
        dragCounters.current[sectionName] = (dragCounters.current[sectionName] ?? 0) + 1
        setDragOverSection(sectionName)
      },
      onDragLeave: () => {
        dragCounters.current[sectionName] = (dragCounters.current[sectionName] ?? 1) - 1
        if (dragCounters.current[sectionName] === 0) setDragOverSection(null)
      },
      onDrop: () => {
        dragCounters.current[sectionName] = 0
        setDragOverSection(null)
        handleFieldDrop(sectionName)
      },
    }
  }

  return {
    draggingFieldId,
    setDraggingFieldId,
    dragOverSection,
    draggingOverFieldId,
    setDraggingOverFieldId,
    sectionedFields,
    nullSectionFields,
    handleFieldDrop,
    handleWithinSectionDrop,
    sectionDragProps,
  }
}
