import { useMemo, useState, useEffect } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  type CalendarEvent,
  bucketEvents,
  eventsForDate,
  fetchCalendarEvents,
} from '../../lib/api/calendar'
import { useAuthStore } from '../../lib/auth/store'

// Calendar home (WIREFRAME 1).
//
//   ┌──────────────────────────────────────┐
//   │ Today                                │
//   │ Wed, May 13 · 5 meetings             │
//   ├──────────────────────────────────────┤
//   │ EARLIER TODAY                        │
//   │   9:00  Standup            [dimmed]  │
//   │   ─────────────────────              │
//   │ NOW                                  │
//   │   11:00 1:1 with Alice    [crimson]  │
//   │ NEXT                                 │
//   │   2:00 PM  FooCorp pitch  [crimson]  │
//   │ LATER                                │
//   │   4:00 PM  Investor sync             │
//   └──────────────────────────────────────┘
//
// Real recording / FAB / details land in M3 / M2. M1b just renders the list.

export default function CalendarTab() {
  const signOut = useAuthStore((s) => s.signOut)
  // Pin "now" once per render cycle so all bucketing decisions agree, and
  // tick every minute so the next-meeting highlight migrates naturally as
  // time passes (without re-fetching from the network).
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const handle = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(handle)
  }, [])

  const query = useQuery({
    queryKey: ['calendar', 'events', 'today'],
    queryFn: ({ signal }) => fetchCalendarEvents({ signal }),
    // 30s fresh — quick refetches while the user lingers, but skip the network
    // when they're swiping back and forth.
    staleTime: 30_000,
  })

  // Mobile filters the gateway's two-week window down to today's events.
  // Keeping the broader window cached means tomorrow's events are ready
  // instantly if the user pages forward (lands in M2).
  const todays = useMemo(() => {
    if (!query.data) return []
    return eventsForDate(query.data, now)
  }, [query.data, now])

  const buckets = useMemo(() => bucketEvents(todays, now), [todays, now])
  const dateLabel = useMemo(() => formatDateHeader(now), [now])

  // 401 reauth_required → kick to sign-in. The API client already cleared
  // SecureStore, so we just need to navigate.
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Today</Text>
        <Text style={styles.headerSubtitle}>
          {dateLabel}
          {todays.length > 0 ? ` · ${todays.length} meeting${todays.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => query.refetch()}
            tintColor="#fafafa"
          />
        }
      >
        {query.isLoading && !query.data && (
          <View style={styles.center}>
            <ActivityIndicator color="#fafafa" />
          </View>
        )}

        {query.error && !query.data && <ErrorState error={query.error} onRetry={() => query.refetch()} />}

        {query.data && todays.length === 0 && <EmptyState />}

        {buckets.earlier.length > 0 && (
          <Section title="Earlier today" dimmed>
            {buckets.earlier.map((ev) => (
              <EventRow key={ev.id} event={ev} variant="dimmed" />
            ))}
          </Section>
        )}

        {buckets.now.length > 0 && (
          <Section title="Now" highlight>
            {buckets.now.map((ev) => (
              <EventRow key={ev.id} event={ev} variant="active" />
            ))}
          </Section>
        )}

        {buckets.next && (
          <Section title="Up next" highlight>
            <EventRow event={buckets.next} variant="next" />
          </Section>
        )}

        {buckets.later.length > 0 && (
          <Section title="Later today">
            {buckets.later.map((ev) => (
              <EventRow key={ev.id} event={ev} variant="default" />
            ))}
          </Section>
        )}

        <View style={styles.footer}>
          <Pressable onPress={signOut} style={styles.signOut}>
            <Text style={styles.signOutText}>Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

function Section({
  title,
  children,
  dimmed,
  highlight,
}: {
  title: string
  children: React.ReactNode
  dimmed?: boolean
  highlight?: boolean
}) {
  return (
    <View style={styles.section}>
      <Text
        style={[
          styles.sectionTitle,
          dimmed && styles.sectionTitleDimmed,
          highlight && styles.sectionTitleHighlight,
        ]}
      >
        {title}
      </Text>
      {children}
    </View>
  )
}

type EventRowVariant = 'default' | 'dimmed' | 'active' | 'next'

function EventRow({ event, variant }: { event: CalendarEvent; variant: EventRowVariant }) {
  const time = event.isAllDay ? 'All day' : `${formatTime(event.start)} – ${formatTime(event.end)}`
  const attendeeCount = event.attendees.length
  return (
    <Pressable
      // Tap behavior: meeting detail screen lands in M2; for now this is
      // visually pressable but inert.
      onPress={() => undefined}
      style={({ pressed }) => [
        styles.row,
        variant === 'dimmed' && styles.rowDimmed,
        variant === 'active' && styles.rowActive,
        variant === 'next' && styles.rowNext,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.rowTime}>
        <Text
          style={[
            styles.rowTimeText,
            variant === 'dimmed' && styles.textDimmed,
          ]}
        >
          {time.split(' – ')[0]}
        </Text>
      </View>
      <View style={styles.rowBody}>
        <Text
          numberOfLines={2}
          style={[
            styles.rowTitle,
            variant === 'dimmed' && styles.textDimmed,
          ]}
        >
          {event.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {[
            time.includes(' – ') ? time.split(' – ')[1] : null,
            attendeeCount > 0 ? `${attendeeCount} attendee${attendeeCount === 1 ? '' : 's'}` : null,
            event.location ?? null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
    </Pressable>
  )
}

function EmptyState() {
  return (
    <View style={styles.center}>
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
      <Pressable onPress={onRetry} style={styles.retry}>
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

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
  },
  headerTitle: {
    color: '#fafafa',
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  headerSubtitle: {
    color: '#888',
    fontSize: 14,
    marginTop: 4,
  },
  scroll: { paddingTop: 8, paddingBottom: 60 },

  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionTitle: {
    color: '#666',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  sectionTitleDimmed: { color: '#555' },
  sectionTitleHighlight: { color: '#dc2626' },

  row: {
    flexDirection: 'row',
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1a1a1a',
  },
  rowDimmed: { opacity: 0.55 },
  rowActive: { borderColor: '#dc2626' },
  rowNext: { borderColor: '#dc2626', backgroundColor: '#1f1010' },
  rowPressed: { opacity: 0.7 },
  rowTime: { width: 64 },
  rowTimeText: { color: '#bbb', fontSize: 14, fontWeight: '600' },
  rowBody: { flex: 1, marginLeft: 8 },
  rowTitle: { color: '#fafafa', fontSize: 16, fontWeight: '600', lineHeight: 20 },
  rowMeta: { color: '#888', fontSize: 12, marginTop: 4 },
  textDimmed: { color: '#777' },

  center: { padding: 32, alignItems: 'center', justifyContent: 'center', minHeight: 200 },
  emptyTitle: { color: '#bbb', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  emptySubtitle: { color: '#777', fontSize: 13 },
  errorTitle: { color: '#f87171', fontSize: 16, fontWeight: '600', marginBottom: 8 },
  errorMessage: { color: '#888', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  retry: {
    backgroundColor: '#1a1a1a',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  retryText: { color: '#fafafa', fontSize: 14, fontWeight: '500' },

  footer: { paddingHorizontal: 24, paddingTop: 32 },
  signOut: {
    backgroundColor: '#1a1a1a',
    borderColor: '#2a2a2a',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  signOutText: { color: '#888', fontSize: 13, fontWeight: '500' },
})
