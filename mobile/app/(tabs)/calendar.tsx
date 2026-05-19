import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  bucketEvents,
  eventsForDate,
  fetchCalendarEvents,
} from '../../lib/api/calendar'
import { useAuthStore } from '../../lib/auth/store'
import { Avatar } from '../../components/Avatar'
import { MeetingRow } from '../../components/MeetingRow'
import { NowRail } from '../../components/NowRail'
import { RecordFab } from '../../components/RecordFab'
import { colors, radii, spacing, type } from '../../theme'

// Calendar home — WIREFRAME 1.
//
// Composition:
//   • SafeArea + app bar (Today / date / count + search icon + avatar)
//   • Sectioned scroll (Earlier today / Now / Up next / Later today)
//   • NowRail divider between Earlier and Now+Next
//   • RecordFab pinned bottom-right above the tab bar
//
// The bucketing logic (eventsForDate + bucketEvents) and data fetching
// (TanStack Query + MMKV persister) are unchanged from M1b — this pass
// is pure presentation.

export default function CalendarTab() {
  const userId = useAuthStore((s) => s.userId)
  const signOut = useAuthStore((s) => s.signOut)

  // Pin "now" per render cycle, tick every minute so the next-meeting
  // highlight migrates naturally as time passes (without a network refetch).
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(handle)
  }, [])

  const query = useQuery({
    queryKey: ['calendar', 'events', 'today'],
    queryFn: ({ signal }) => fetchCalendarEvents({ signal }),
    staleTime: 30_000,
  })

  const todays = useMemo(() => {
    if (!query.data) return []
    return eventsForDate(query.data, now)
  }, [query.data, now])

  const buckets = useMemo(() => bucketEvents(todays, now), [todays, now])
  const dateLabel = useMemo(() => formatDateHeader(now), [now])
  const nowLabel = useMemo(() => formatNowLabel(now), [now])

  // 401 reauth_required → kick to sign-in.
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const meetingCount = todays.length

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.appbar}>
          <View style={styles.appbarTitleWrap}>
            <Text style={styles.appbarTitle}>Today</Text>
            <Text style={styles.appbarSubtitle}>
              {dateLabel}
              {meetingCount > 0
                ? ` · ${meetingCount} meeting${meetingCount === 1 ? '' : 's'}`
                : ''}
            </Text>
          </View>
          <View style={styles.appbarActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Search"
              onPress={() => router.push('/search')}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
            >
              <Ionicons name="search" size={16} color={colors.text2} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Account"
              onPress={() => openAccountSheet(userId, signOut)}
              hitSlop={8}
            >
              <Avatar initials={initialsFromUserId(userId)} size={32} />
            </Pressable>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => query.refetch()}
            tintColor={colors.crimson}
          />
        }
      >
        {query.isLoading && !query.data && (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        )}

        {query.error && !query.data && (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}

        {query.data && meetingCount === 0 && <EmptyState />}

        {buckets.earlier.length > 0 && (
          <View style={styles.section}>
            <SectionHeader label="Earlier today" />
            {buckets.earlier.map((ev) => (
              <MeetingRow key={ev.id} event={ev} variant="past" />
            ))}
          </View>
        )}

        {(buckets.earlier.length > 0 ||
          buckets.now.length > 0 ||
          buckets.next ||
          buckets.later.length > 0) && <NowRail label={nowLabel} />}

        {buckets.now.length > 0 && (
          <View style={styles.section}>
            <SectionHeader label="Now" highlight />
            {buckets.now.map((ev) => (
              <MeetingRow key={ev.id} event={ev} variant="active" />
            ))}
          </View>
        )}

        {buckets.next && (
          <View style={styles.section}>
            <SectionHeader label="Up next" highlight />
            <MeetingRow event={buckets.next} variant="next" />
          </View>
        )}

        {buckets.later.length > 0 && (
          <View style={styles.section}>
            <SectionHeader label="Later today" />
            {buckets.later.map((ev) => (
              <MeetingRow key={ev.id} event={ev} variant="later" />
            ))}
          </View>
        )}

        <View style={styles.footer} />
      </ScrollView>

      <RecordFab />
    </View>
  )
}

function SectionHeader({ label, highlight }: { label: string; highlight?: boolean }) {
  return (
    <View style={styles.sectionHeader}>
      {highlight && <View style={styles.sectionHeaderDot} />}
      <Text style={[styles.sectionHeaderText, highlight && styles.sectionHeaderHighlight]}>
        {label}
      </Text>
    </View>
  )
}

function EmptyState() {
  return (
    <View style={styles.center}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="calendar-clear-outline" size={36} color={colors.text4} />
      </View>
      <Text style={styles.emptyTitle}>No meetings today</Text>
      <Text style={styles.emptySubtitle}>Pull down to refresh.</Text>
    </View>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Could not load calendar'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Calendar failed to load</Text>
      <Text style={styles.errorMessage}>{message}</Text>
      <Pressable
        onPress={onRetry}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
      >
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  )
}

function formatDateHeader(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatNowLabel(d: Date): string {
  return d
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(/\s?(AM|PM)$/i, '')
}

function initialsFromUserId(userId: string | null): string {
  if (!userId) return '?'
  // userId is a cuid2 — first two alphas as a stable placeholder until
  // /auth/me's displayName lands. M2 swaps this for real initials.
  return userId.slice(0, 2).toUpperCase()
}

function openAccountSheet(_userId: string | null, signOut: () => Promise<void>): void {
  Alert.alert('Account', undefined, [
    { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    { text: 'Cancel', style: 'cancel' },
  ])
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  appbar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  appbarTitleWrap: { flex: 1, minWidth: 0 },
  appbarTitle: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.6,
    lineHeight: 28,
  },
  appbarSubtitle: {
    color: colors.text3,
    fontSize: type.meta + 1,
    fontWeight: '500',
    marginTop: 2,
  },
  appbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },

  scroll: { paddingBottom: 140, backgroundColor: colors.bg },

  section: { backgroundColor: colors.surface },
  sectionHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
  },
  sectionHeaderText: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionHeaderHighlight: { color: colors.crimson },
  sectionHeaderDot: {
    width: 6,
    height: 6,
    borderRadius: 99,
    backgroundColor: colors.rec,
  },

  center: {
    paddingVertical: 48,
    paddingHorizontal: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 240,
    backgroundColor: colors.surface,
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtitle: { color: colors.text3, fontSize: type.bodyTight },

  errorTitle: {
    color: colors.crimson,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  errorMessage: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  retry: {
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
  },
  retryText: { color: colors.text, fontSize: type.bodyTight, fontWeight: '500' },

  footer: { height: spacing.xl },
})
