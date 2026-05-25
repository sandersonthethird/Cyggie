import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { ApiError } from '../lib/api/client'
import type { CalendarEvent } from '../lib/api/calendar'
import { MeetingRow } from './MeetingRow'
import type { MeetingDetail } from '../lib/api/meetings'
import { colors, spacing, type } from '../theme'

// T16 — "My Recordings" section. Lists impromptu (no-cal-event) meetings
// from the last 7 days at the top of the calendar Past segment so they're
// findable after the user closes the app post-recording.
//
// Rendered inside the past FlatList's ListHeaderComponent so it scrolls
// naturally with the rest of the list.
//
// States:
//   • isLoading && !meetings  → skeleton row (single ActivityIndicator)
//   • error                    → inline error banner (not the whole list)
//   • meetings.length === 0    → section hidden (return null)
//   • meetings.length > 0      → header + rows (adapt MeetingDetail to
//                                CalendarEvent shape for the existing
//                                MeetingRow component; no new row type)
//
// Extracted from mobile/app/(tabs)/calendar.tsx as part of MC.runner so
// the component can be rendered and asserted on under Jest + RNTL.

export interface ImpromptuRecordingsSectionProps {
  meetings: MeetingDetail[] | null
  isLoading: boolean
  error: Error | null
  onPress: (id: string) => void
}

export function ImpromptuRecordingsSection({
  meetings,
  isLoading,
  error,
  onPress,
}: ImpromptuRecordingsSectionProps) {
  if (isLoading && !meetings) {
    return (
      <View style={styles.section}>
        <Header />
        <View style={styles.skeleton} testID="impromptu-skeleton">
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
        <Header />
        <Text style={styles.errorText} testID="impromptu-error">
          Couldn't load recordings — {msg}
        </Text>
      </View>
    )
  }

  if (!meetings || meetings.length === 0) {
    return null
  }

  return (
    <View style={styles.section} testID="impromptu-section">
      <Header />
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

function Header() {
  return (
    <View style={styles.header}>
      <Text style={styles.headerText}>MY RECORDINGS</Text>
    </View>
  )
}

// Adapter: MeetingDetail → CalendarEvent shape so the existing MeetingRow
// renders impromptu rows without a new variant or row component. Calendar
// attendees are empty (impromptu meetings have no calendar invite); start/
// end derive from `date` + `durationSeconds` so the duration cell renders.
//
// Exported for tests so the conversion can be asserted directly.
export function impromptuMeetingToCalendarEvent(m: MeetingDetail): CalendarEvent {
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

const styles = StyleSheet.create({
  section: { backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: 14,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
  },
  headerText: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  skeleton: {
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    color: colors.text3,
    fontSize: type.bodyTight,
  },
})
