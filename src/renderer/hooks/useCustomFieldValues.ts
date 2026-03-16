import { useState, useEffect, useMemo } from 'react'
import { api } from '../api'
import { IPC_CHANNELS } from '../../shared/constants/channels'

type BulkValues = Record<string, Record<string, string>>

/**
 * Fetches and caches custom field values for all entities of the given type.
 * Re-fetches when visible custom column IDs change, when rowCount changes
 * (new entity created/deleted), or on window focus (so values edited in the
 * detail panel are reflected in the table without navigation).
 *
 * Also exposes a `patch` function for optimistic local updates after inline edits.
 */
export function useCustomFieldValues(
  entityType: 'company' | 'contact',
  visibleKeys: string[],
  rowCount: number
): { values: BulkValues; patch: (entityId: string, defId: string, value: string | null) => void } {
  const [values, setValues] = useState<BulkValues>({})

  const defIds = useMemo(
    () => visibleKeys.filter((k) => k.startsWith('custom:')).map((k) => k.slice(7)),
    [visibleKeys]
  )
  const defIdsKey = defIds.join(',')

  function fetchValues() {
    if (defIds.length === 0) {
      setValues({})
      return
    }
    api
      .invoke<{ success: boolean; data?: BulkValues }>(
        IPC_CHANNELS.CUSTOM_FIELD_GET_BULK_VALUES,
        entityType,
        defIds
      )
      .then((r) => {
        if (r.success && r.data) setValues(r.data)
        else console.warn('[customFields] getBulkFieldValues failed', r)
      })
  }

  // Refetch when visible custom columns or row count changes
  useEffect(() => {
    fetchValues()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defIdsKey, rowCount])

  // Refetch on window focus so table reflects values edited in the detail panel
  useEffect(() => {
    window.addEventListener('focus', fetchValues)
    return () => window.removeEventListener('focus', fetchValues)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defIdsKey])

  function patch(entityId: string, defId: string, value: string | null) {
    setValues((prev) => ({
      ...prev,
      [entityId]: { ...(prev[entityId] ?? {}), [defId]: value ?? '' },
    }))
  }

  return { values, patch }
}
