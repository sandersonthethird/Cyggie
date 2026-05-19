import { StyleSheet, Text, View, Pressable } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { CalendarEvent } from '../lib/api/calendar'
import { colors, radii, spacing, type } from '../theme'

// Meeting row anatomy from WIREFRAME 1.
//
//   ┌────┬──────────────────────────────────────────┬──────────┐
//   │ 9  │ Init Labs — founder check-in             │  ● Next  │
//   │ 30 │ Init Labs · Priya M. · Adrian C.         │          │
//   │ AM │                                          │          │
//   │ 60 │                                          │          │
//   │ min│                                          │          │
//   └────┴──────────────────────────────────────────┴──────────┘
//
// Variants:
//   past   — dimmed; checkmark badge slot reserved for M2 (when we have
//            meeting.has_notes from the gateway).
//   next   — crimson left-border, "Next" badge with pulsing dot.
//   active — same border treatment as next; used for any meeting that is
//            currently in progress (now ∈ [start, end]).
//   later  — default neutral.

export type MeetingRowVariant = 'past' | 'next' | 'active' | 'later'

export interface MeetingRowProps {
  event: CalendarEvent
  variant: MeetingRowVariant
  onPress?: () => void
}

export function MeetingRow({ event, variant, onPress }: MeetingRowProps) {
  const start = event.isAllDay ? null : new Date(event.start)
  const end = event.isAllDay ? null : new Date(event.end)
  const durationMin =
    start && end ? Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000)) : 0

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.root,
        variant === 'past' && styles.past,
        (variant === 'next' || variant === 'active') && styles.nextOrActive,
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.timeCol}>
        {event.isAllDay ? (
          <Text style={[styles.timeText, variant === 'past' && styles.textDim]}>All</Text>
        ) : (
          <>
            <Text style={[styles.timeText, variant === 'past' && styles.textDim]}>
              {formatHourMinute(start!)}
            </Text>
            <Text style={[styles.ampm, variant === 'past' && styles.textDim]}>
              {formatAmPm(start!)}
            </Text>
            <Text style={[styles.duration, variant === 'past' && styles.textDim]}>
              {durationMin} min
            </Text>
          </>
        )}
      </View>

      <View style={styles.body}>
        <Text
          style={[styles.title, variant === 'past' && styles.textDim]}
          numberOfLines={2}
        >
          {event.title}
        </Text>
        <Text
          style={[styles.meta, variant === 'past' && styles.metaDim]}
          numberOfLines={1}
        >
          {buildMetaLine(event)}
        </Text>
      </View>

      <View style={styles.endCol}>
        {variant === 'next' && (
          <View style={styles.nextBadge}>
            <View style={styles.nextDot} />
            <Text style={styles.nextBadgeText}>Next</Text>
          </View>
        )}
        {variant === 'active' && (
          <View style={styles.activeBadge}>
            <View style={styles.nextDot} />
            <Text style={styles.activeBadgeText}>Now</Text>
          </View>
        )}
        {variant === 'past' && (
          // M2 will conditionally render this when meeting.has_notes lands;
          // V1 leaves the slot empty so the row width stays stable.
          <View style={styles.endSlot} />
        )}
      </View>
    </Pressable>
  )
}

function formatHourMinute(d: Date): string {
  // "9:30" — no AM/PM suffix here; that lives in the row below for vertical compactness.
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace(/\s?(AM|PM)$/i, '')
}

function formatAmPm(d: Date): string {
  // Returns "AM" / "PM" only.
  const m = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    hour12: true,
  }).match(/(AM|PM)$/i)
  return m ? m[1]!.toUpperCase() : ''
}

function buildMetaLine(event: CalendarEvent): string {
  const parts: string[] = []
  const attendeeCount = event.attendees.length
  if (attendeeCount > 0) {
    parts.push(`${attendeeCount} attendee${attendeeCount === 1 ? '' : 's'}`)
  }
  if (event.location) parts.push(event.location)
  if (event.meetingUrl && parts.length === 0) parts.push('Video call')
  return parts.join(' · ')
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 11,
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSoft,
    backgroundColor: colors.surface,
  },
  past: { opacity: 0.55 },
  nextOrActive: {
    borderLeftWidth: 3,
    borderLeftColor: colors.crimson,
    backgroundColor: colors.crimsonMuted,
    paddingLeft: spacing.lg - 3, // keep content alignment after the border eats 3px
  },
  pressed: { opacity: 0.7 },

  timeCol: {
    width: 54,
    alignItems: 'flex-start',
  },
  timeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.text3,
    fontVariant: ['tabular-nums'],
  },
  ampm: {
    fontSize: 9.5,
    color: colors.text4,
    fontWeight: '500',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginTop: 1,
  },
  duration: {
    fontSize: 9.5,
    color: colors.text4,
    fontWeight: '500',
    marginTop: 4,
  },
  textDim: { color: colors.text4 },

  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: type.body,
    fontWeight: '600',
    color: colors.text,
    letterSpacing: -0.05,
    lineHeight: 18,
  },
  meta: {
    fontSize: type.meta,
    color: colors.text3,
    marginTop: 4,
  },
  metaDim: { color: colors.text4 },

  endCol: {
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    minWidth: 56,
  },
  endSlot: { width: 1, height: 1 },

  nextBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  nextBadgeText: {
    color: colors.crimson,
    fontSize: 10.5,
    fontWeight: '600',
  },
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.crimson,
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  activeBadgeText: {
    color: colors.surface,
    fontSize: 10.5,
    fontWeight: '600',
  },
  nextDot: {
    width: 5,
    height: 5,
    borderRadius: 99,
    backgroundColor: colors.rec,
  },
})

// Silence unused-icon-import warning until M2 wires the Notes-badge variant.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _IoniconsRef = Ionicons
