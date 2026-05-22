import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useFocusEffect } from '@react-navigation/native'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  bucketEvents,
  eventsForDate,
  fetchCalendarEvents,
  type CalendarEvent,
} from '../../lib/api/calendar'
import { prepareMeetingFromCalendarEvent } from '../../lib/api/meetings'
import { useAuthStore } from '../../lib/auth/store'
import { Avatar } from '../../components/Avatar'
import { MeetingRow } from '../../components/MeetingRow'
import { NowRail } from '../../components/NowRail'
import { RecordFab } from '../../components/RecordFab'
import { appStateStorage } from '../../lib/cache/mmkv'
import { pullSince } from '../../lib/sync/pull'
import { colors, radii, spacing, type } from '../../theme'

const ONBOARDING_TOOLTIP_KEY = 'onboarding.notes-tooltip-seen'

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
  const queryClient = useQueryClient()
  const tapBusyRef = useRef(false)
  const [tooltipVisible, setTooltipVisible] = useState(false)

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

  // Phase 1.5b — pull deltas from Neon whenever the tab focuses so writes
  // from another device (desktop, second phone) appear without a manual
  // refresh. Failures are silent — the next tick will retry.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false
      void pullSince()
        .then((res) => {
          if (cancelled) return
          if (res.changedIds.length === 0) return
          for (const id of res.changedIds) {
            queryClient.invalidateQueries({ queryKey: ['meetings', 'detail', id] })
          }
        })
        .catch(() => undefined)
      return () => {
        cancelled = true
      }
    }, [queryClient]),
  )

  // D7 — first-tap onboarding tooltip. Show after the first calendar load,
  // dismiss permanently once tapped.
  useEffect(() => {
    if (tooltipVisible) return
    if (!query.data || query.data.length === 0) return
    if (appStateStorage.getString(ONBOARDING_TOOLTIP_KEY)) return
    setTooltipVisible(true)
  }, [query.data, tooltipVisible])

  const dismissTooltip = useCallback(() => {
    appStateStorage.set(ONBOARDING_TOOLTIP_KEY, '1')
    setTooltipVisible(false)
  }, [])

  const handleEventPress = useCallback(
    async (event: CalendarEvent) => {
      // Guard against double-tap while the prepare round-trip is in flight.
      if (tapBusyRef.current) return
      dismissTooltip()
      // Fast path: gateway already linked a meeting via the /calendar/events
      // join. Skip the round-trip and navigate directly.
      if (event.meetingId) {
        router.push(`/meetings/${event.meetingId}`)
        return
      }
      tapBusyRef.current = true
      try {
        // Normalize the start time to UTC ISO (Z suffix). Google Calendar
        // hands us either `2026-05-22T10:00:00-04:00` (timed) or
        // `2026-05-22` (all-day); the gateway's z.string().datetime()
        // schema rejects both. new Date(...).toISOString() canonicalizes
        // to YYYY-MM-DDTHH:mm:ss.sssZ.
        const startTimeIso = new Date(event.start).toISOString()
        const meeting = await prepareMeetingFromCalendarEvent({
          calendarEventId: event.calendarEventId,
          title: event.title,
          startTime: startTimeIso,
          attendees: event.attendees.map((a) => a.displayName ?? a.email),
          attendeeEmails: event.attendees.map((a) => a.email).filter((e) => e.length > 0),
          ...(event.meetingUrl ? { meetingUrl: event.meetingUrl } : {}),
        })
        router.push(`/meetings/${meeting.id}`)
        // Refresh the calendar list — the next render should now carry the
        // linked meetingId so a follow-up tap takes the fast path.
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'events', 'today'] })
      } catch (err) {
        if (err instanceof ApiError && err.reauthRequired) {
          await signOut()
          router.replace('/(auth)/sign-in')
          return
        }
        // Surface other errors to the dev console so silent failures don't
        // get lost. User-visible toast lands in a follow-up.
        console.error('[calendar] handleEventPress failed', err)
      } finally {
        tapBusyRef.current = false
      }
    },
    [dismissTooltip, queryClient, signOut],
  )

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

        {tooltipVisible && (
          <OnboardingTooltip onDismiss={dismissTooltip} />
        )}

        {buckets.earlier.length > 0 && (
          <View style={styles.section}>
            <SectionHeader label="Earlier today" />
            {buckets.earlier.map((ev) => (
              <MeetingRow
                key={ev.id}
                event={ev}
                variant="past"
                onPress={() => void handleEventPress(ev)}
              />
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
              <MeetingRow
                key={ev.id}
                event={ev}
                variant="active"
                onPress={() => void handleEventPress(ev)}
              />
            ))}
          </View>
        )}

        {buckets.next && (
          <View style={styles.section}>
            <SectionHeader label="Up next" highlight />
            <MeetingRow
              event={buckets.next}
              variant="next"
              onPress={() => void handleEventPress(buckets.next!)}
            />
          </View>
        )}

        {buckets.later.length > 0 && (
          <View style={styles.section}>
            <SectionHeader label="Later today" />
            {buckets.later.map((ev) => (
              <MeetingRow
                key={ev.id}
                event={ev}
                variant="later"
                onPress={() => void handleEventPress(ev)}
              />
            ))}
          </View>
        )}

        <View style={styles.footer} />
      </ScrollView>

      <RecordFab onPress={() => router.push('/record')} />
    </View>
  )
}

function OnboardingTooltip({ onDismiss }: { onDismiss: () => void }) {
  return (
    <View style={styles.tooltip}>
      <View style={styles.tooltipIcon}>
        <Ionicons name="bulb-outline" size={16} color={colors.crimson} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.tooltipTitle}>Tap any event to take notes</Text>
        <Text style={styles.tooltipSubtitle}>
          Notes sync across your devices — type ahead of a meeting, see them on
          desktop.
        </Text>
      </View>
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        style={({ pressed }) => [styles.tooltipClose, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Dismiss tip"
      >
        <Ionicons name="close" size={16} color={colors.text3} />
      </Pressable>
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

  tooltip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.crimson,
  },
  tooltipIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tooltipTitle: {
    color: colors.text,
    fontSize: type.bodyTight,
    fontWeight: '600',
  },
  tooltipSubtitle: {
    color: colors.text3,
    fontSize: type.caption + 1,
    marginTop: 2,
  },
  tooltipClose: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
