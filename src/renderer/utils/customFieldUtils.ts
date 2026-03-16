import type { CustomFieldType } from '../../shared/types/custom-fields'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { useCustomFieldStore } from '../stores/custom-fields.store'
import { api } from '../api'

export const FIELD_TYPES: Array<{ value: CustomFieldType; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'boolean', label: 'Yes/No' },
  { value: 'select', label: 'Select' },
  { value: 'multiselect', label: 'Multi-select' },
  { value: 'currency', label: 'Currency' },
]

export function slugify(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

/**
 * Add a new option to a custom select/multiselect field's optionsJson.
 * Deduplicates, sanitizes, persists via IPC, and refreshes the store.
 * Throws if the IPC update fails. Logs a warning if store refresh fails
 * (non-fatal — the update already persisted).
 */
/**
 * Merge hardcoded built-in options with user-added extensions from options_json.
 * Returns hardcoded options unchanged if optionsJson is null or malformed.
 */
export function mergeBuiltinOptions(
  hardcoded: { value: string; label: string }[],
  optionsJson: string | null
): { value: string; label: string }[] {
  if (!optionsJson) return hardcoded
  try {
    const ext: string[] = JSON.parse(optionsJson)
    return [...hardcoded, ...ext.map((v) => ({ value: v, label: v }))]
  } catch {
    return hardcoded
  }
}

export async function addCustomFieldOption(
  defId: string,
  currentOptionsJson: string | null,
  newOption: string
): Promise<void> {
  const opt = newOption.trim().slice(0, 200)
  if (!opt) return

  let current: string[] = []
  if (currentOptionsJson) {
    try { current = JSON.parse(currentOptionsJson) } catch { current = [] }
  }
  if (current.includes(opt)) return

  const updated = JSON.stringify([...current, opt])
  const result = await api.invoke<{ success: boolean; message?: string }>(
    IPC_CHANNELS.CUSTOM_FIELD_UPDATE_DEFINITION,
    defId,
    { optionsJson: updated }
  )
  if (!result.success) throw new Error(result.message ?? 'Failed to update field options')

  try {
    await useCustomFieldStore.getState().refresh()
  } catch (e) {
    console.warn('[addCustomFieldOption] store refresh failed (non-fatal):', e)
  }
}
