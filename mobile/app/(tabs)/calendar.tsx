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
  formatDayLabel,
  getCalendarFetchWindow,
  groupByDay,
  safeIso,
  type CalendarDaySection,
  type CalendarEvent,
} from '../../lib/api/calendar'
import { prepareMeetingFromCalendarEvent } from '../../lib/api/meetings'
import { useAuthStore } from '../../lib/auth/store'
import { useCalendarStore } from '../../lib/calendar/store'
import { Avatar } from '../../components/Avatar'
import { ErrorBanner } from '../../components/ErrorBanner'
import { MeetingRow } from '../../components/MeetingRow'
import { NowRail } from '../../components/NowRail'
import { formatErrorMessage } from '../../lib/banner/banner-state'
import { RecordFab } from '../../components/RecordFab'
import { appStateStorage } from '../../lib/cache/mmkv'
import { pullSince } from '../../lib/sync/pull'
import { colors, radii, spacing, type } from '../../theme'

type Segment = 'today' | 'upcoming' | 'past'

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
  // T13: inline error banner for non-auth failures in the tap handler.
  // Auto-dismisses after 4s; race-safe via useEffect cleanup.
  const [bannerMsg, setBannerMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!bannerMsg) return
    const t = setTimeout(() => setBannerMsg(null), 4000)
    return () => clearTimeout(t)
  }, [bannerMsg])
  const [segment, setSegment] = useState<Segment>('today')

  // Pin "now" per render cycle, tick every minute so the next-meeting
  // highlight migrates naturally as time passes (without a network refetch).
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(handle)
  }, [])

  // Day-granular memo key — Upcoming/Past derivations only need to refire
  // when the calendar day rolls over, not every minute the `now` ticker fires.
  const nowDay = useMemo(() => now.toDateString(), [now])

  const query = useQuery({
    queryKey: ['calendar', 'events', 'window'],
    queryFn: ({ signal }) => {
      // Use a fresh `new Date()` here (not the per-minute `now` state).
      // Window is day-granular and we don't want a refetch every tick.
      const { from, to } = getCalendarFetchWindow(new Date())
      return fetchCalendarEvents({ from, to, signal })
    },
    staleTime: 30_000,
  })

  const dismissedIds = useCalendarStore((s) => s.dismissedIds)
  const isDismissed = useCalendarStore((s) => s.isDismissed)
  const dismiss = useCalendarStore((s) => s.dismiss)
  const undismissAll = useCalendarStore((s) => s.undismissAll)

  // Filter dismissed events at the source so all three segments see the
  // same visible-event population. Re-derives only when query.data or
  // the dismissed set changes.
  const visibleEvents = useMemo(
    () => (query.data ?? []).filter((ev) => !isDismissed(ev.id)),
    [query.data, isDismissed, dismissedIds],
  )

  const todays = useMemo(() => eventsForDate(visibleEvents, now), [visibleEvents, now])

  const buckets = useMemo(() => bucketEvents(todays, now), [todays, now])

  // Upcoming and Past derivations key on nowDay so they don't recompute
  // every minute. Day-granular is correct — sections shift only on
  // midnight crossings.
  const upcomingSections = useMemo<CalendarDaySection[]>(() => {
    if (visibleEvents.length === 0) return []
    const tomorrow = new Date(now)
    tomorrow.setHours(0, 0, 0, 0)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return groupByDay(visibleEvents, tomorrow, 13)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEvents, nowDay])

  const pastSections = useMemo<CalendarDaySection[]>(() => {
    if (visibleEvents.length === 0) return []
    const sevenAgo = new Date(now)
    sevenAgo.setHours(0, 0, 0, 0)
    sevenAgo.setDate(sevenAgo.getDate() - 7)
    return [...groupByDay(visibleEvents, sevenAgo, 7)].reverse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleEvents, nowDay])

  const upcomingCount = useMemo(
    () => upcomingSections.reduce((n, s) => n + s.events.length, 0),
    [upcomingSections],
  )
  const pastCount = useMemo(
    () => pastSections.reduce((n, s) => n + s.events.length, 0),
    [pastSections],
  )
  const totalAcrossWindow = todays.length + upcomingCount + pastCount

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
  // dismiss permanently once tapped. Only triggers on the Today segment;
  // switching away dismisses it (so it doesn't reappear on segment return).
  useEffect(() => {
    if (tooltipVisible) return
    if (segment !== 'today') return
    if (totalAcrossWindow === 0) return
    if (appStateStorage.getString(ONBOARDING_TOOLTIP_KEY)) return
    setTooltipVisible(true)
  }, [segment, totalAcrossWindow, tooltipVisible])

  const dismissTooltip = useCallback(() => {
    appStateStorage.set(ONBOARDING_TOOLTIP_KEY, '1')
    setTooltipVisible(false)
  }, [])

  const handleSegmentChange = useCallback(
    (next: Segment) => {
      if (next === segment) return
      // Switching segments counts as acknowledging the tooltip — partners who
      // explore the new segments don't need the prompt anymore.
      if (tooltipVisible) dismissTooltip()
      setSegment(next)
    },
    [segment, tooltipVisible, dismissTooltip],
  )

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
        // Normalize start/end to UTC ISO (Z suffix). Gateway now accepts
        // TZ offsets (T10) so this is robustness — and safeIso also
        // protects against the all-day case where event.end can be
        // empty/null (`new Date('').toISOString()` would otherwise throw
        // RangeError; safeIso returns null and we omit endTime).
        const startTimeIso = safeIso(event.start)
        const endTimeIso = safeIso(event.end)
        if (!startTimeIso) {
          // Defensive — should never happen since calendar list filters out
          // events without a parseable start. If it does, skip the tap
          // rather than crash.
          return
        }
        const meeting = await prepareMeetingFromCalendarEvent({
          calendarEventId: event.calendarEventId,
          title: event.title,
          startTime: startTimeIso,
          attendees: event.attendees.map((a) => a.displayName ?? a.email),
          attendeeEmails: event.attendees.map((a) => a.email).filter((e) => e.length > 0),
          ...(endTimeIso ? { endTime: endTimeIso } : {}),
          ...(event.meetingUrl ? { meetingUrl: event.meetingUrl } : {}),
        })
        router.push(`/meetings/${meeting.id}`)
        // Refresh the calendar list — the next render should now carry the
        // linked meetingId so a follow-up tap takes the fast path.
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'events', 'window'] })
      } catch (err) {
        if (err instanceof ApiError && err.reauthRequired) {
          await signOut()
          router.replace('/(auth)/sign-in')
          return
        }
        // T13: surface non-auth failures via the inline error banner.
        // formatErrorMessage returns null for the reauth case (handled
        // above) so we won't ever double-show.
        const msg = formatErrorMessage(err)
        if (msg) setBannerMsg(msg)
        console.error('[calendar] handleEventPress failed', err)
      } finally {
        tapBusyRef.current = false
      }
    },
    [dismissTooltip, queryClient, signOut],
  )

  const title = segmentTitle(segment)
  const subtitle = segmentSubtitle(segment, dateLabel, todays.length, upcomingCount, pastCount)
  const segmentEmpty =
    (segment === 'today' && todays.length === 0) ||
    (segment === 'upcoming' && upcomingCount === 0) ||
    (segment === 'past' && pastCount === 0)

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.appbar}>
          <View style={styles.appbarTitleWrap}>
            <Text style={styles.appbarTitle}>{title}</Text>
            <Text style={styles.appbarSubtitle}>{subtitle}</Text>
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
              onPress={() => openAccountSheet(userId, signOut, dismissedIds.size, undismissAll)}
              hitSlop={8}
            >
              <Avatar initials={initialsFromUserId(userId)} size={32} />
            </Pressable>
          </View>
        </View>
        <SegmentControl active={segment} onChange={handleSegmentChange} />
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
        <ErrorBanner message={bannerMsg} onDismiss={() => setBannerMsg(null)} />

        {query.isLoading && !query.data && (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        )}

        {query.error && !query.data && (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}

        {query.data && segmentEmpty && <EmptyState segment={segment} />}

        {tooltipVisible && segment === 'today' && (
          <OnboardingTooltip onDismiss={dismissTooltip} />
        )}

        {segment === 'today' && (
          <>
            {buckets.earlier.length > 0 && (
              <View style={styles.section}>
                <SectionHeader label="Earlier today" />
                {buckets.earlier.map((ev) => (
                  <MeetingRow
                    key={ev.id}
                    event={ev}
                    variant="past"
                    onPress={() => void handleEventPress(ev)}
                    onDismiss={() => dismiss(ev.id)}
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
                    onDismiss={() => dismiss(ev.id)}
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
                  onDismiss={() => dismiss(buckets.next!.id)}
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
                    onDismiss={() => dismiss(ev.id)}
                  />
                ))}
              </View>
            )}
          </>
        )}

        {segment === 'upcoming' &&
          upcomingSections.map((section) => (
            <View key={section.dayKey} style={styles.section}>
              <SectionHeader label={formatDayLabel(section.date, now).toUpperCase()} />
              {section.events.map((ev) => (
                <MeetingRow
                  key={ev.id}
                  event={ev}
                  variant="later"
                  onPress={() => void handleEventPress(ev)}
                  onDismiss={() => dismiss(ev.id)}
                />
              ))}
            </View>
          ))}

        {segment === 'past' &&
          pastSections.map((section) => (
            <View key={section.dayKey} style={styles.section}>
              <SectionHeader label={formatDayLabel(section.date, now).toUpperCase()} />
              {section.events.map((ev) => (
                <MeetingRow
                  key={ev.id}
                  event={ev}
                  variant="past"
                  onPress={() => void handleEventPress(ev)}
                  onDismiss={() => dismiss(ev.id)}
                />
              ))}
            </View>
          ))}

        <View style={styles.footer} />
      </ScrollView>

      <RecordFab onPress={() => router.push('/record')} />
    </View>
  )
}

function SegmentControl({
  active,
  onChange,
}: {
  active: Segment
  onChange: (next: Segment) => void
}) {
  const items: { key: Segment; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'past', label: 'Past' },
  ]
  return (
    <View style={styles.segmentWrap}>
      {items.map((item) => {
        const isActive = item.key === active
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ selected: isActive }}
            onPress={() => onChange(item.key)}
            style={({ pressed }) => [
              styles.segmentChip,
              isActive && styles.segmentChipActive,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[styles.segmentChipText, isActive && styles.segmentChipTextActive]}
            >
              {item.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function segmentTitle(segment: Segment): string {
  if (segment === 'today') return 'Today'
  if (segment === 'upcoming') return 'Upcoming'
  return 'Past'
}

function segmentSubtitle(
  segment: Segment,
  dateLabel: string,
  todayCount: number,
  upcomingCount: number,
  pastCount: number,
): string {
  if (segment === 'today') {
    if (todayCount === 0) return dateLabel
    return `${dateLabel} · ${todayCount} meeting${todayCount === 1 ? '' : 's'}`
  }
  if (segment === 'upcoming') {
    return `Next 14 days · ${upcomingCount} meeting${upcomingCount === 1 ? '' : 's'}`
  }
  return `Last 7 days · ${pastCount} meeting${pastCount === 1 ? '' : 's'}`
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

function EmptyState({ segment }: { segment: Segment }) {
  const copy = (() => {
    if (segment === 'today') {
      return { title: 'No meetings today', subtitle: 'Pull down to refresh.' }
    }
    if (segment === 'upcoming') {
      return {
        title: 'No upcoming meetings',
        subtitle: "You're clear for the next two weeks.",
      }
    }
    return { title: 'No recent meetings', subtitle: 'The past week was quiet.' }
  })()
  return (
    <View style={styles.center}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="calendar-clear-outline" size={36} color={colors.text4} />
      </View>
      <Text style={styles.emptyTitle}>{copy.title}</Text>
      <Text style={styles.emptySubtitle}>{copy.subtitle}</Text>
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

function openAccountSheet(
  _userId: string | null,
  signOut: () => Promise<void>,
  hiddenCount: number,
  undismissAll: () => void,
): void {
  const buttons: Parameters<typeof Alert.alert>[2] = []
  if (hiddenCount > 0) {
    buttons.push({
      text: `Show hidden events (${hiddenCount})`,
      onPress: () => {
        Alert.alert(
          `Restore ${hiddenCount} hidden event${hiddenCount === 1 ? '' : 's'}?`,
          undefined,
          [
            { text: 'Restore', onPress: () => undismissAll() },
            { text: 'Cancel', style: 'cancel' },
          ],
        )
      },
    })
  }
  buttons.push({ text: 'Sign out', style: 'destructive', onPress: () => void signOut() })
  buttons.push({ text: 'Cancel', style: 'cancel' })
  Alert.alert('Account', undefined, buttons)
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

  segmentWrap: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  segmentChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
  },
  segmentChipActive: {
    backgroundColor: colors.crimson,
  },
  segmentChipText: {
    color: colors.text2,
    fontSize: type.bodyTight,
    fontWeight: '600',
  },
  segmentChipTextActive: {
    color: colors.surface,
  },

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
