import { useEffect } from 'react'
import { router, Stack } from 'expo-router'
import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import * as Notifications from 'expo-notifications'
import * as WebBrowser from 'expo-web-browser'
import { useAuthStore } from '../lib/auth/store'
import { mmkvAsyncStorage } from '../lib/cache/mmkv'
import { registerForPushNotifications } from '../lib/push/register'
import { loadMostRecentPendingUploadOrEvict } from '../lib/recording/pending-upload'
import { RecordingBubble } from '../components/RecordingBubble'
import { initSync, shutdownSync } from '../lib/sync/boot'

// Required at module top-level so any pending ASWebAuthenticationSession
// redirect (e.g. from a previous sign-in that closed mid-flow) is flushed
// before the next openAuthSessionAsync call. Without this, the second
// sign-in attempt within a single app run can close silently after Google's
// "Allow" because the system still has state from the prior session.
WebBrowser.maybeCompleteAuthSession()

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

// Configure how the system handles foreground notifications. M3 only fires
// "transcription ready" — keep the banner + sound so the user notices even
// if they're idling on a different screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

export default function RootLayout() {
  const hydrate = useAuthStore((s) => s.hydrate)
  const authStatus = useAuthStore((s) => s.status)
  const userId = useAuthStore((s) => s.userId)

  // Rehydrate auth state from SecureStore once on mount. Until this resolves,
  // status='idle' → status='loading'; the index dispatcher waits for one of
  // signed_in / signed_out before navigating.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // M3 — register the APNs device token with the gateway whenever auth flips
  // to signed_in. registerForPushNotifications dedup's against its last
  // posted token so cold-starts of an already-signed-in app are cheap.
  useEffect(() => {
    if (authStatus !== 'signed_in') return
    void registerForPushNotifications()
  }, [authStatus])

  // Phase 1.5b — wire the sync outbox/agent the first time we're signed in.
  // initSync is idempotent; shutdown on full sign-out so the periodic drain
  // doesn't continue firing against a signed-out gateway client.
  useEffect(() => {
    if (authStatus === 'signed_in') {
      initSync()
      return () => shutdownSync()
    }
    return undefined
  }, [authStatus])

  // 3A — post-signin recovery surface for unsent recordings. If the user
  // is signed in AND has a recoverable PendingUpload (audio still on
  // disk, MMKV slot present, owned by this userId), route them straight
  // to /record so the retry banner is visible immediately. Without this,
  // a refresh-fail signOut would dump them at the calendar with no
  // affordance for their stranded recording.
  //
  // Idempotent: the route's mount-action logic decides what to render
  // based on the same MMKV state; running this twice is harmless. We
  // gate on userId not just authStatus so the effect doesn't fire
  // during the brief signed_in-but-userId-null hydrate window.
  useEffect(() => {
    if (authStatus !== 'signed_in') return
    if (!userId) return
    let cancelled = false
    void (async () => {
      const pending = await loadMostRecentPendingUploadOrEvict(userId)
      if (cancelled) return
      if (!pending) return
      router.replace('/record')
    })()
    return () => {
      cancelled = true
    }
  }, [authStatus, userId])

  // Notification tap handler — when the user taps a "transcript ready" push,
  // navigate straight to the meeting detail. The payload carries meetingId
  // from the gateway's APNs send.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { meetingId?: string }
      if (data?.meetingId) {
        router.push(`/meetings/${data.meetingId}`)
      }
    })
    return () => sub.remove()
  }, [])

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
          {/* Global floating recording indicator — visible on every screen
              except the active meeting's view while recording. */}
          <RecordingBubble />
          <StatusBar style="dark" />
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
