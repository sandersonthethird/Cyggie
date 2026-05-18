import { Stack } from 'expo-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

// Root layout. Wraps the navigator tree in:
//   • TanStack Query — server state cache (read paths + write mutations)
//   • Gesture handler — required by react-native-reanimated and most RN libs
//   • SafeAreaProvider — for proper inset handling on devices with notches
//
// Auth-gated routing lands in Step 6/7; for now this is a flat Stack so
// the placeholder index screen renders.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Mobile is bandwidth-conscious. Stale-while-revalidate keeps the UI
      // responsive on flaky connections; explicit refetches handle freshness
      // where it matters.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Stack screenOptions={{ headerShown: false }} />
          <StatusBar style="auto" />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
