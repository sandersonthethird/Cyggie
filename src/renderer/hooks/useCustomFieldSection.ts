import { useRef, useState } from 'react'
import type { CustomFieldEntityType, CustomFieldWithValue } from '../../shared/types/custom-fields'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

export function useCustomFieldSection(
  _entityType: CustomFieldEntityType,
  _entityId: string,
  customFields: CustomFieldWithValue[],
  setCustomFields: React.Dispatch<React.SetStateAction<CustomFieldWithValue[]>>
) {
  const [draggingFieldId, setDraggingFieldId] = useState<string | null>(null)
  const [dragOverSection, setDragOverSection] = useState<string | null>(null)
  // Counter per section to handle onDragLeave firing when entering child elements
  const dragCounters = useRef<Record<string, number>>({})

  function sectionedFields(section: string): CustomFieldWithValue[] {
    return customFields.filter((f) => f.section === section)
  }

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
    sectionedFields,
    handleFieldDrop,
    sectionDragProps,
  }
}
