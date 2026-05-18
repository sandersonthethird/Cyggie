import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useAuthStore } from '../lib/auth/store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mobile-friendly defaults: cache hits stay warm for 30s, no aggressive
      // refetch on focus, one retry. Tightened per-query where freshness matters.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
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
        <QueryClientProvider client={queryClient}>
          <Stack screenOptions={{ headerShown: false }} />
          <StatusBar style="light" />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
