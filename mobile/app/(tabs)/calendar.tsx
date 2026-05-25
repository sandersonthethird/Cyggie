import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  type ListRenderItem,
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
import {
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  bucketEvents,
  eventsForDate,
  fetchCalendarEvents,
  formatDayLabel,
  getCalendarTodayWindow,
  groupByDay,
  safeIso,
  useCalendarInfiniteQuery,
  type CalendarDaySection,
  type CalendarEvent,
  type CalendarPage,
} from '../../lib/api/calendar'
import {
  fetchImpromptuMeetings,
  prepareMeetingFromCalendarEvent,
  type MeetingDetail,
} from '../../lib/api/meetings'
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

  // Stable "now" anchor for the infinite queries so cursor + queryKey
  // don't churn per-minute. Recomputes once per calendar day.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowAnchor = useMemo(() => new Date(), [nowDay])

  // Today's events: single-day window (today only). Past/Upcoming
  // segments handle everything outside today via infinite scroll.
  const todayQuery = useQuery({
    queryKey: ['calendar', 'today', nowDay],
    queryFn: ({ signal }) => {
      const { from, to } = getCalendarTodayWindow(new Date())
      return fetchCalendarEvents({ from, to, signal })
    },
    staleTime: 30_000,
  })

  // Item 1 — true infinite scroll for past + upcoming. Each page is a
  // 30-day window; cursor advances per page; pageToken drains in-window
  // truncation (>250 events). 5 consecutive empty pages stops loading.
  const upcomingInf = useCalendarInfiniteQuery({ direction: 'future', now: nowAnchor })
  const pastInf = useCalendarInfiniteQuery({ direction: 'past', now: nowAnchor })

  // T16 — recent impromptu (no-cal-event) meetings. Only fetched when the
  // user is on the Past segment; otherwise we waste a request. staleTime
  // 60s + refetchOnWindowFocus matches the desktop pull-tick cadence so
  // a meeting recorded on the desktop within the last minute appears on
  // mobile within ~1s of foregrounding the app.
  const impromptuQuery = useQuery({
    queryKey: ['calendar', 'impromptu', '7d'],
    queryFn: ({ signal }) => fetchImpromptuMeetings({ days: 7, signal }),
    enabled: segment === 'past',
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })

  // dismissedIds is consumed only as a useMemo dep below — isDismissed is a
  // stable function reference, so without subscribing to the Set the filter
  // wouldn't re-derive when partners hide/restore events.
  const dismissedIds = useCalendarStore((s) => s.dismissedIds)
  const isDismissed = useCalendarStore((s) => s.isDismissed)
  const dismiss = useCalendarStore((s) => s.dismiss)

  // Today is filtered down to the events that fall in today's local day +
  // not dismissed; then bucketed into earlier/now/next/later.
  const todays = useMemo(() => {
    const todayEvents = (todayQuery.data?.events ?? []).filter((ev) => !isDismissed(ev.id))
    return eventsForDate(todayEvents, now)
  }, [todayQuery.data, isDismissed, dismissedIds, now])

  const buckets = useMemo(() => bucketEvents(todays, now), [todays, now])

  // Flatten infinite-query pages → events → groupByDay. Keys on nowDay so
  // section derivation runs at most once per day-flip (and once per page
  // load). The groupByDay window spans from the earliest cursor to today
  // (past) or from tomorrow to the latest cursor (future) — we ask
  // groupByDay for "all days touched by these events" by computing a
  // tight window around min/max event date.
  const upcomingEvents = useMemo(
    () =>
      (upcomingInf.data?.pages ?? [])
        .flatMap((p) => p.events)
        .filter((ev) => !isDismissed(ev.id)),
    [upcomingInf.data, isDismissed, dismissedIds],
  )
  const pastEvents = useMemo(
    () =>
      (pastInf.data?.pages ?? [])
        .flatMap((p) => p.events)
        .filter((ev) => !isDismissed(ev.id)),
    [pastInf.data, isDismissed, dismissedIds],
  )

  const upcomingSections = useMemo<CalendarDaySection[]>(() => {
    if (upcomingEvents.length === 0) return []
    // Span the full loaded window: tomorrow → max(event.start)+1d.
    const tomorrow = new Date(nowAnchor)
    tomorrow.setHours(0, 0, 0, 0)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const maxStart = upcomingEvents.reduce(
      (acc, ev) => Math.max(acc, new Date(ev.start).getTime()),
      tomorrow.getTime(),
    )
    const daysSpan = Math.max(
      1,
      Math.ceil((maxStart - tomorrow.getTime()) / 86400_000) + 1,
    )
    return groupByDay(upcomingEvents, tomorrow, daysSpan)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upcomingEvents, nowDay])

  const pastSections = useMemo<CalendarDaySection[]>(() => {
    if (pastEvents.length === 0) return []
    // Span min(event.start) → today exclusive.
    const startOfToday = new Date(nowAnchor)
    startOfToday.setHours(0, 0, 0, 0)
    const minStart = pastEvents.reduce(
      (acc, ev) => Math.min(acc, new Date(ev.start).getTime()),
      startOfToday.getTime(),
    )
    const earliestDay = new Date(minStart)
    earliestDay.setHours(0, 0, 0, 0)
    const daysSpan = Math.max(
      1,
      Math.ceil((startOfToday.getTime() - earliestDay.getTime()) / 86400_000),
    )
    return [...groupByDay(pastEvents, earliestDay, daysSpan)].reverse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastEvents, nowDay])

  const upcomingCount = upcomingEvents.length
  const pastCount = pastEvents.length
  const totalAcrossWindow = todays.length + upcomingCount + pastCount

  const dateLabel = useMemo(() => formatDateHeader(now), [now])
  const nowLabel = useMemo(() => formatNowLabel(now), [now])

  // 401 reauth_required → kick to sign-in. Any of the three queries
  // can surface this; first one wins.
  useEffect(() => {
    const err = todayQuery.error ?? upcomingInf.error ?? pastInf.error
    if (err instanceof ApiError && err.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [todayQuery.error, upcomingInf.error, pastInf.error, signOut])

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
        // Refresh the relevant calendar query so the next render carries
        // the linked meetingId (fast path on a follow-up tap). Today,
        // upcoming and past each have their own queryKey now.
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'today'] })
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'future'] })
        void queryClient.invalidateQueries({ queryKey: ['calendar', 'past'] })
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
              accessibilityLabel="Settings"
              onPress={() => router.push('/settings')}
              hitSlop={8}
            >
              <Avatar initials={initialsFromUserId(userId)} size={32} />
            </Pressable>
          </View>
        </View>
        <SegmentControl active={segment} onChange={handleSegmentChange} />
      </SafeAreaView>

      {segment === 'today' && (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl
              refreshing={todayQuery.isRefetching}
              onRefresh={() => todayQuery.refetch()}
              tintColor={colors.crimson}
            />
          }
        >
          <ErrorBanner message={bannerMsg} onDismiss={() => setBannerMsg(null)} />

          {todayQuery.isLoading && !todayQuery.data && (
            <View style={styles.center}>
              <ActivityIndicator color={colors.crimson} />
            </View>
          )}

          {todayQuery.error && !todayQuery.data && (
            <ErrorState error={todayQuery.error} onRetry={() => todayQuery.refetch()} />
          )}

          {todayQuery.data && segmentEmpty && <EmptyState segment={segment} />}

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

          <View style={styles.footer} />
        </ScrollView>
      )}

      {segment === 'upcoming' && (
        <InfiniteCalendarList
          sections={upcomingSections}
          variant="later"
          isLoading={upcomingInf.isLoading && !upcomingInf.data}
          isRefetching={upcomingInf.isRefetching}
          isFetchingNextPage={upcomingInf.isFetchingNextPage}
          hasNextPage={upcomingInf.hasNextPage}
          error={upcomingInf.error}
          onEndReached={() => {
            if (upcomingInf.hasNextPage && !upcomingInf.isFetchingNextPage) {
              void upcomingInf.fetchNextPage()
            }
          }}
          onRefresh={() => {
            // 4A — refresh first page only. Drop pages 2+ from the
            // cache then refetch the now-single remaining page. Deeper
            // pages reload as the user scrolls back.
            queryClient.setQueryData<InfiniteData<CalendarPage>>(
              ['calendar', 'future'],
              (old) =>
                old
                  ? {
                      pages: old.pages.slice(0, 1),
                      pageParams: old.pageParams.slice(0, 1),
                    }
                  : old,
            )
            void upcomingInf.refetch()
          }}
          onRetry={() => upcomingInf.refetch()}
          onEventPress={handleEventPress}
          onEventDismiss={dismiss}
          isEmpty={upcomingCount === 0 && !upcomingInf.isLoading}
          emptySegment="upcoming"
          now={now}
          bannerMsg={bannerMsg}
          onDismissBanner={() => setBannerMsg(null)}
        />
      )}

      {segment === 'past' && (
        <InfiniteCalendarList
          sections={pastSections}
          variant="past"
          isLoading={pastInf.isLoading && !pastInf.data}
          isRefetching={pastInf.isRefetching}
          isFetchingNextPage={pastInf.isFetchingNextPage}
          hasNextPage={pastInf.hasNextPage}
          error={pastInf.error}
          onEndReached={() => {
            if (pastInf.hasNextPage && !pastInf.isFetchingNextPage) {
              void pastInf.fetchNextPage()
            }
          }}
          onRefresh={() => {
            queryClient.setQueryData<InfiniteData<CalendarPage>>(
              ['calendar', 'past'],
              (old) =>
                old
                  ? {
                      pages: old.pages.slice(0, 1),
                      pageParams: old.pageParams.slice(0, 1),
                    }
                  : old,
            )
            void pastInf.refetch()
            void impromptuQuery.refetch()
          }}
          onRetry={() => pastInf.refetch()}
          onEventPress={handleEventPress}
          onEventDismiss={dismiss}
          isEmpty={pastCount === 0 && !pastInf.isLoading}
          emptySegment="past"
          now={now}
          bannerMsg={bannerMsg}
          onDismissBanner={() => setBannerMsg(null)}
          impromptuMeetings={impromptuQuery.data ?? null}
          impromptuLoading={impromptuQuery.isLoading}
          impromptuError={impromptuQuery.error}
          onImpromptuPress={(id) => router.push(`/meetings/${id}`)}
        />
      )}

      <RecordFab onPress={() => router.push('/record')} />
    </View>
  )
}

// ─── InfiniteCalendarList ───────────────────────────────────────────────────
// Flat list of header/row items for the Upcoming + Past segments. Keeps
// onEndReached on the FlatList (vs SectionList) — simpler virtualization
// and consistent footer behavior. Flattening day sections into a single
// list of `{type:'header'|'row'}` items keeps key stability per event.

type FlatItem =
  | { type: 'header'; key: string; date: Date }
  | { type: 'row'; key: string; event: CalendarEvent }

function flattenSections(
  sections: CalendarDaySection[],
): FlatItem[] {
  const out: FlatItem[] = []
  for (const section of sections) {
    out.push({ type: 'header', key: `h-${section.dayKey}`, date: section.date })
    for (const ev of section.events) {
      out.push({ type: 'row', key: `r-${ev.id}`, event: ev })
    }
  }
  return out
}

function InfiniteCalendarList({
  sections,
  variant,
  isLoading,
  isRefetching,
  isFetchingNextPage,
  hasNextPage,
  error,
  onEndReached,
  onRefresh,
  onRetry,
  onEventPress,
  onEventDismiss,
  isEmpty,
  emptySegment,
  now,
  bannerMsg,
  onDismissBanner,
  impromptuMeetings,
  impromptuLoading,
  impromptuError,
  onImpromptuPress,
}: {
  sections: CalendarDaySection[]
  variant: 'later' | 'past'
  isLoading: boolean
  isRefetching: boolean
  isFetchingNextPage: boolean
  hasNextPage: boolean
  error: Error | null
  onEndReached: () => void
  onRefresh: () => void
  onRetry: () => void
  onEventPress: (ev: CalendarEvent) => void
  onEventDismiss: (id: string) => void
  isEmpty: boolean
  emptySegment: Segment
  now: Date
  bannerMsg: string | null
  onDismissBanner: () => void
  // T16 — impromptu (no-cal-event) meetings rendered above the date-grouped
  // past events. Only passed when variant === 'past'; safe defaults
  // ('My Recordings' hidden) for the 'later' variant.
  impromptuMeetings?: MeetingDetail[] | null
  impromptuLoading?: boolean
  impromptuError?: Error | null
  onImpromptuPress?: (id: string) => void
}) {
  const data = useMemo(() => flattenSections(sections), [sections])

  const renderItem: ListRenderItem<FlatItem> = useCallback(
    ({ item }) => {
      if (item.type === 'header') {
        return <SectionHeader label={formatDayLabel(item.date, now).toUpperCase()} />
      }
      return (
        <MeetingRow
          event={item.event}
          variant={variant}
          onPress={() => onEventPress(item.event)}
          onDismiss={() => onEventDismiss(item.event.id)}
        />
      )
    },
    [now, onEventDismiss, onEventPress, variant],
  )

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.crimson} />
      </View>
    )
  }

  if (error && data.length === 0) {
    return <ErrorState error={error} onRetry={onRetry} />
  }

  return (
    <FlatList
      data={data}
      renderItem={renderItem}
      keyExtractor={(it) => it.key}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={onRefresh}
          tintColor={colors.crimson}
        />
      }
      ListHeaderComponent={
        <>
          <ErrorBanner message={bannerMsg} onDismiss={onDismissBanner} />
          {variant === 'past' && (
            <ImpromptuRecordingsSection
              meetings={impromptuMeetings ?? null}
              isLoading={!!impromptuLoading}
              error={impromptuError ?? null}
              onPress={onImpromptuPress ?? (() => {})}
            />
          )}
        </>
      }
      ListEmptyComponent={isEmpty ? <EmptyState segment={emptySegment} /> : null}
      ListFooterComponent={
        isFetchingNextPage ? (
          <View style={styles.footerSpinner}>
            <ActivityIndicator color={colors.crimson} size="small" />
          </View>
        ) : hasNextPage ? null : (
          <View style={styles.footer} />
        )
      }
      contentContainerStyle={styles.scroll}
    />
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
    const count = upcomingCount === 0 ? '0' : `${upcomingCount}+`
    return `Upcoming · ${count} meeting${upcomingCount === 1 ? '' : 's'}`
  }
  const count = pastCount === 0 ? '0' : `${pastCount}+`
  return `Past · ${count} meeting${pastCount === 1 ? '' : 's'}`
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

// T16 — "My Recordings" section. Lists impromptu (no-cal-event) meetings
// from the last 7 days at the top of the Past segment so they're findable
// after the user closes the app post-recording. Rendered inside the past
// FlatList's ListHeaderComponent so it scrolls naturally with the rest.
//
// States:
//   • isLoading && !meetings  → skeleton row (single ActivityIndicator)
//   • error                    → inline error banner (not the whole list)
//   • meetings.length === 0    → section hidden (return null)
//   • meetings.length > 0      → header + rows (adapt MeetingDetail to
//                                CalendarEvent shape for the existing
//                                MeetingRow component; no new row type)
function ImpromptuRecordingsSection({
  meetings,
  isLoading,
  error,
  onPress,
}: {
  meetings: MeetingDetail[] | null
  isLoading: boolean
  error: Error | null
  onPress: (id: string) => void
}) {
  if (isLoading && !meetings) {
    return (
      <View style={styles.section}>
        <SectionHeader label="My Recordings" />
        <View style={styles.impromptuSkeleton}>
          <ActivityIndicator color={colors.crimson} size="small" />
        </View>
      </View>
    )
  }

  if (error) {
    const msg =
      error instanceof ApiError
        ? `${error.code}: ${error.message}`
        : error.message
    return (
      <View style={styles.section}>
        <SectionHeader label="My Recordings" />
        <Text style={styles.impromptuError}>Couldn't load recordings — {msg}</Text>
      </View>
    )
  }

  if (!meetings || meetings.length === 0) {
    return null
  }

  return (
    <View style={styles.section}>
      <SectionHeader label="My Recordings" />
      {meetings.map((m) => (
        <MeetingRow
          key={m.id}
          event={impromptuMeetingToCalendarEvent(m)}
          variant="past"
          onPress={() => onPress(m.id)}
        />
      ))}
    </View>
  )
}

// Adapter: MeetingDetail → CalendarEvent shape so the existing MeetingRow
// renders impromptu rows without a new variant or row component. Calendar
// attendees are empty (impromptu meetings have no calendar invite); start/
// end derive from `date` + `durationSeconds` so the duration cell renders.
function impromptuMeetingToCalendarEvent(m: MeetingDetail): CalendarEvent {
  const startMs = new Date(m.date).getTime()
  const durMs = (m.durationSeconds ?? 0) * 1000
  return {
    id: m.id,
    calendarEventId: '',
    title: m.title,
    start: m.date,
    end: new Date(startMs + durMs).toISOString(),
    attendees: [],
    isAllDay: false,
    recordingStatus: m.status,
    meetingId: m.id,
  }
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
  footerSpinner: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // T16 — "My Recordings" section states.
  impromptuSkeleton: {
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  impromptuError: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.text3,
    fontSize: type.bodyTight,
  },

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
