import { create } from 'zustand'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CustomFieldDefinition, CustomFieldEntityType } from '../../shared/types/custom-fields'
import { api } from '../api'

interface CustomFieldStoreState {
  companyDefs: CustomFieldDefinition[]
  contactDefs: CustomFieldDefinition[]
  loaded: boolean
  load: () => Promise<void>
  refresh: () => Promise<void>
}

async function fetchDefs(entityType: CustomFieldEntityType): Promise<CustomFieldDefinition[]> {
  const result = await api.invoke<{ success: boolean; data?: CustomFieldDefinition[] }>(
    IPC_CHANNELS.CUSTOM_FIELD_LIST_DEFINITIONS,
    entityType
  )
  if (result.success && result.data) return result.data
  return []
}

export const useCustomFieldStore = create<CustomFieldStoreState>((set, get) => ({
  companyDefs: [],
  contactDefs: [],
  loaded: false,

  load: async () => {
    if (get().loaded) return
    const [companyDefs, contactDefs] = await Promise.all([
      fetchDefs('company'),
      fetchDefs('contact')
    ])
    set({ companyDefs, contactDefs, loaded: true })
  },

  refresh: async () => {
    const [companyDefs, contactDefs] = await Promise.all([
      fetchDefs('company'),
      fetchDefs('contact')
    ])
    set({ companyDefs, contactDefs, loaded: true })
  }
}))
