import { useCallback } from 'react'
import { usePreferencesStore } from '../stores/preferences.store'

export type CollapsibleEntity = 'company' | 'contact'

export interface SectionCollapseApi {
  isCollapsed: (sectionKey: string) => boolean
  toggle: (sectionKey: string) => void
  collapsedKeys: string[]
}

/**
 * Per-entity collapsed-section persistence backed by usePreferencesStore.
 * Storage key: `cyggie:${entity}-collapsed:${entityId}` (string[]).
 */
export function useSectionCollapse(entity: CollapsibleEntity, entityId: string): SectionCollapseApi {
  const { getJSON, setJSON } = usePreferencesStore()
  const key = `cyggie:${entity}-collapsed:${entityId}`
  const collapsedKeys = getJSON<string[]>(key, [])

  const isCollapsed = useCallback(
    (sectionKey: string) => collapsedKeys.includes(sectionKey),
    [collapsedKeys],
  )

  const toggle = useCallback(
    (sectionKey: string) => {
      const next = collapsedKeys.includes(sectionKey)
        ? collapsedKeys.filter((k) => k !== sectionKey)
        : [...collapsedKeys, sectionKey]
      setJSON(key, next)
    },
    [collapsedKeys, key, setJSON],
  )

  return { isCollapsed, toggle, collapsedKeys }
}
