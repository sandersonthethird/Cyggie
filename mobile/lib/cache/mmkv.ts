import { MMKV } from 'react-native-mmkv'

// MMKV is significantly faster than AsyncStorage for the chatty
// read-on-render workload TanStack Query produces. We use it as the
// persistence layer for query cache (so cold starts show cached
// data immediately) and for app-level small key-value state.
//
// Two separate instances:
//   queryCache  — TanStack Query's persisted cache. Bounded by size below.
//   appState    — non-cache settings (last-seen route, feature toggles).

export const queryCacheStorage = new MMKV({
  id: 'cyggie.query-cache',
})

export const appStateStorage = new MMKV({
  id: 'cyggie.app-state',
})

// AsyncStorage-shaped adapter so @tanstack/query-async-storage-persister
// can drive MMKV. AsyncStorage's API is async (Promise-based) and MMKV's
// is sync — we wrap with Promise.resolve to bridge.
export const mmkvAsyncStorage = {
  async setItem(key: string, value: string): Promise<void> {
    queryCacheStorage.set(key, value)
  },
  async getItem(key: string): Promise<string | null> {
    const v = queryCacheStorage.getString(key)
    return v ?? null
  },
  async removeItem(key: string): Promise<void> {
    queryCacheStorage.delete(key)
  },
}
