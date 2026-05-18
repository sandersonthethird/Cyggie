import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useAuthStore } from '../lib/auth/store'
import { mmkvAsyncStorage } from '../lib/cache/mmkv'

const ONE_DAY_MS = 1000 * 60 * 60 * 24

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mobile-friendly defaults: cache hits stay warm for 30s, no aggressive
      // refetch on focus, one retry. Tightened per-query where freshness matters.
      staleTime: 30_000,
      // gcTime (was cacheTime in v4) sets how long inactive queries stay in
      // memory + on disk. 24 hours so a cold launch shows yesterday's data
      // while the network refetches.
      gcTime: ONE_DAY_MS,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// MMKV-backed persister. TanStack Query writes the entire client cache as
// one JSON blob — fine for our scale (single-firm calendar, a few hundred
// queries max). When data grows large enough to feel the IO, switch to
// dehydrateOptions filters so only specific keys persist.
const persister = createAsyncStoragePersister({
  storage: mmkvAsyncStorage,
  key: 'cyggie.query-cache.v1',
  throttleTime: 1000, // batch writes — Mobile MMKV is fast but no need to thrash
})

export default function RootLayout() {
  const hydrate = useAuthStore((s) => s.hydrate)

  // Rehydrate auth state from SecureStore once on mount. Until this resolves,
  // status='idle' → status='loading'; the index dispatcher waits for one of
  // signed_in / signed_out before navigating.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister,
            maxAge: ONE_DAY_MS,
            buster: 'v1', // bump to invalidate stale caches after breaking schema changes
          }}
        >
          <Stack screenOptions={{ headerShown: false }} />
          <StatusBar style="light" />
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
