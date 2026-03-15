import { create } from 'zustand'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import { api } from '../api'

interface PreferencesStore {
  loaded: boolean
  prefs: Record<string, string>
  load: () => Promise<void>
  getJSON: <T>(key: string, defaultValue: T) => T
  setJSON: <T>(key: string, value: T) => void
}

export const usePreferencesStore = create<PreferencesStore>((set, get) => ({
  loaded: false,
  prefs: {},

  load: async () => {
    if (get().loaded) return
    const prefs = await api.invoke<Record<string, string>>(IPC_CHANNELS.USER_PREF_GET_ALL)
    set({ prefs: prefs ?? {}, loaded: true })
  },

  getJSON: <T>(key: string, defaultValue: T): T => {
    const raw = get().prefs[key]
    if (raw == null) return defaultValue
    try {
      return JSON.parse(raw) as T
    } catch {
      return defaultValue
    }
  },

  setJSON: <T>(key: string, value: T): void => {
    const serialized = JSON.stringify(value)
    // Optimistic update
    set((state) => ({ prefs: { ...state.prefs, [key]: serialized } }))
    // Async persist
    window.api
      .invoke(IPC_CHANNELS.USER_PREF_SET, key, serialized)
      .catch((err: unknown) => console.warn('[PreferencesStore] Failed to persist preference:', key, err))
  }
}))
