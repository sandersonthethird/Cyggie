import { useEffect } from 'react'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { usePreferencesStore } from '../stores/preferences.store'

type EntityType = 'contact' | 'company'

/**
 * One-time migration: moves fields from the old "Pinned section" preference
 * (cyggie:contact-pinned-fields / cyggie:company-pinned-fields) into the
 * 'summary' section by updating each field's section via IPC.
 *
 * Safety rules:
 *  - The pref key is cleared ONLY after ALL IPC calls succeed.
 *  - If any IPC call returns a process error, the pref is left intact for retry.
 *  - "Not found" (field deleted) is treated as success and skipped gracefully.
 */
export function usePinnedMigration(entityType: EntityType) {
  const { getJSON, setJSON } = usePreferencesStore()
  const prefKey = `cyggie:${entityType}-pinned-fields`

  useEffect(() => {
    const pinnedFieldKeys = getJSON<string[]>(prefKey, [])
    if (pinnedFieldKeys.length === 0) return

    const fieldIds = pinnedFieldKeys
      .filter((k) => k.startsWith('custom:'))
      .map((k) => k.slice(7))

    if (fieldIds.length === 0) {
      setJSON(prefKey, [])
      return
    }

    ;(async () => {
      const results = await Promise.allSettled(
        fieldIds.map((id) =>
          window.api.invoke(IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION, id, { section: 'summary' })
        )
      )

      const hasProcessError = results.some(
        (r) =>
          r.status === 'rejected' &&
          // "not found" rejections (field deleted) are fine to skip
          !(r.reason && String(r.reason).includes('not found'))
      )

      if (hasProcessError) {
        console.warn('[usePinnedMigration] Some IPC calls failed — leaving pref intact for retry')
        return
      }

      const migratedCount = results.filter((r) => r.status === 'fulfilled').length
      console.log(`[usePinnedMigration] Migrated ${migratedCount} field(s) from Pinned to Header section`)
      setJSON(prefKey, [])
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
}
