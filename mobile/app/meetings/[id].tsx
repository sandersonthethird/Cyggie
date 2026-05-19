import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Linking,
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
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  fetchMeeting,
  type MeetingDetail,
  type MeetingLinkedCompany,
  type MeetingLinkedContact,
  type TranscriptSegment,
} from '../../lib/api/meetings'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

// Meeting detail — third entity in the read-only CRM triangle.
//
// Shape mirrors Company / Contact detail (hero + stats + segmented).
// Segments are Overview / Transcript / People.
//
// Overview shows: notes + linked companies (as chips → /companies/:id) +
//                 attendees list (display-name + email) + meeting platform/URL.
// Transcript shows: a flat list of segments with speaker labels.
// People shows: linked contacts (via speaker_contact_links) → /contacts/:id.

type Segment = 'overview' | 'transcript' | 'people'

export default function MeetingDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const signOut = useAuthStore((s) => s.signOut)
  const [segment, setSegment] = useState<Segment>('overview')

  const query = useQuery({
    queryKey: ['meetings', 'detail', id],
    queryFn: ({ signal }) => fetchMeeting(id, { signal }),
    enabled: id.length > 0,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const meeting = query.data

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {meeting?.title ?? ''}
          </Text>
          <View style={styles.backBtn} />
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
        {query.isLoading && !meeting ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        ) : query.error && !meeting ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : meeting ? (
          <>
            <Hero meeting={meeting} />
            <StatsCard meeting={meeting} />
            <SegmentControl value={segment} onChange={setSegment} />
            {segment === 'overview' && <OverviewSection meeting={meeting} />}
            {segment === 'transcript' && (
              <TranscriptSection
                segments={meeting.transcriptSegments}
                hasTranscript={meeting.hasTranscript}
              />
            )}
            {segment === 'people' && (
              <PeopleSection contacts={meeting.linkedContacts} />
            )}
            <View style={{ height: spacing.xxl }} />
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

function Hero({ meeting }: { meeting: MeetingDetail }) {
  return (
    <View style={styles.hero}>
      <View style={styles.heroAvatar}>
        <Ionicons
          name={meeting.wasImpromptu ? 'flash' : 'calendar'}
          size={28}
          color={colors.crimson}
        />
      </View>
      <Text style={styles.heroName} numberOfLines={3}>
        {meeting.title}
      </Text>
      <Text style={styles.heroSubtitle}>{formatDateLong(meeting.date)}</Text>
      {meeting.meetingUrl && (
        <View style={styles.heroLinks}>
          <LinkChip
            icon="videocam-outline"
            label={meeting.meetingPlatform ?? 'Join'}
            onPress={() => void Linking.openURL(meeting.meetingUrl!)}
          />
        </View>
      )}
    </View>
  )
}

function LinkChip({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.linkChip, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={14} color={colors.text2} />
      <Text style={styles.linkChipText}>{label}</Text>
    </Pressable>
  )
}

function StatsCard({ meeting }: { meeting: MeetingDetail }) {
  return (
    <View style={styles.statsCard}>
      <StatCell
        label="Duration"
        value={meeting.durationSeconds ? formatDuration(meeting.durationSeconds) : '—'}
      />
      <View style={styles.statDivider} />
      <StatCell label="Status" value={humanize(meeting.status)} />
      <View style={styles.statDivider} />
      <StatCell
        label="Speakers"
        value={meeting.speakerCount > 0 ? String(meeting.speakerCount) : '—'}
      />
    </View>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

function SegmentControl({
  value,
  onChange,
}: {
  value: Segment
  onChange: (s: Segment) => void
}) {
  const items: Array<{ key: Segment; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'transcript', label: 'Transcript' },
    { key: 'people', label: 'People' },
  ]
  return (
    <View style={styles.segmentWrap}>
      {items.map((it) => {
        const active = it.key === value
        return (
          <Pressable
            key={it.key}
            onPress={() => onChange(it.key)}
            style={[styles.segmentBtn, active && styles.segmentBtnActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {it.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function OverviewSection({ meeting }: { meeting: MeetingDetail }) {
  return (
    <View style={styles.section}>
      {meeting.notes ? (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>Notes</Text>
          <Text style={styles.descText}>{meeting.notes}</Text>
        </View>
      ) : null}

      {meeting.linkedCompanies.length > 0 && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>Companies</Text>
          <View style={styles.chipRow}>
            {meeting.linkedCompanies.map((c) => (
              <CompanyPill key={c.id} company={c} />
            ))}
          </View>
        </View>
      )}

      {meeting.attendees && meeting.attendees.length > 0 && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>
            Attendees ({meeting.attendees.length})
          </Text>
          {meeting.attendees.map((name, idx) => (
            <Text key={idx} style={styles.attendeeText}>
              {name}
              {meeting.attendeeEmails?.[idx]
                ? `  ·  ${meeting.attendeeEmails[idx]}`
                : ''}
            </Text>
          ))}
        </View>
      )}

      {!meeting.notes &&
        meeting.linkedCompanies.length === 0 &&
        (!meeting.attendees || meeting.attendees.length === 0) && (
          <Text style={styles.emptyInline}>No notes, companies, or attendees yet.</Text>
        )}
    </View>
  )
}

function CompanyPill({ company }: { company: MeetingLinkedCompany }) {
  return (
    <Pressable
      onPress={() => router.push(`/companies/${company.id}`)}
      style={({ pressed }) => [styles.companyPill, pressed && styles.pressed]}
    >
      <Ionicons name="business-outline" size={12} color={colors.crimson} />
      <Text style={styles.companyPillText} numberOfLines={1}>
        {company.name}
      </Text>
    </Pressable>
  )
}

function TranscriptSection({
  segments,
  hasTranscript,
}: {
  segments: TranscriptSegment[]
  hasTranscript: boolean
}) {
  if (!hasTranscript || segments.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>No transcript for this meeting.</Text>
      </View>
    )
  }
  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {segments.map((seg, idx) => (
          <View key={idx}>
            <View style={styles.segmentBlock}>
              <View style={styles.segmentHeaderRow}>
                <Text style={styles.segmentSpeaker}>
                  {seg.speakerLabel ?? `Speaker ${seg.speaker + 1}`}
                </Text>
                <Text style={styles.segmentTime}>
                  {formatTime(seg.startTime)}
                </Text>
              </View>
              <Text style={styles.segmentText}>{seg.text}</Text>
            </View>
            {idx < segments.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

function PeopleSection({ contacts }: { contacts: MeetingLinkedContact[] }) {
  if (contacts.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>
          No speakers tagged as contacts yet.
        </Text>
      </View>
    )
  }
  // Stable sort by speakerIndex so the order matches the transcript flow.
  const sorted = useMemo(
    () => [...contacts].sort((a, b) => a.speakerIndex - b.speakerIndex),
    [contacts],
  )
  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {sorted.map((c, idx) => (
          <View key={c.id}>
            <Pressable
              onPress={() => router.push(`/contacts/${c.id}`)}
              style={({ pressed }) => [styles.personRow, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={c.fullName}
            >
              <View style={styles.personAvatar}>
                <Text style={styles.personAvatarText}>{initials(c.fullName)}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.personName} numberOfLines={1}>
                  {c.fullName}
                </Text>
                <Text style={styles.personMeta} numberOfLines={1}>
                  {c.title ? `${c.title}  ·  ` : ''}Speaker {c.speakerIndex + 1}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.text4} />
            </Pressable>
            {idx < sorted.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Could not load meeting'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Meeting failed to load</Text>
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

function initials(name: string): string {
  const words = name.trim().split(/\s+/).slice(0, 2)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

function humanize(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatDateLong(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}

function formatTime(seconds: number): string {
  // mm:ss or h:mm:ss depending on length.
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  topbarTitle: {
    flex: 1,
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },

  scroll: { backgroundColor: colors.bg, paddingBottom: spacing.xxl },

  hero: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  heroAvatar: {
    width: 60,
    height: 60,
    borderRadius: radii.pill,
    backgroundColor: colors.crimsonMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  heroName: {
    color: colors.text,
    fontSize: type.h1,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.4,
  },
  heroSubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 4,
    textAlign: 'center',
  },
  heroLinks: {
    flexDirection: 'row',
    gap: 8,
    marginTop: spacing.md,
  },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.surface3,
    borderRadius: radii.pill,
  },
  linkChipText: { color: colors.text2, fontSize: type.bodyTight, fontWeight: '500' },

  statsCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
  },
  statCell: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 4,
  },
  statValue: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  statLabel: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 2,
  },

  segmentWrap: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface3,
    borderRadius: radii.md,
    padding: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: radii.sm + 2,
  },
  segmentBtnActive: {
    backgroundColor: colors.surface,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    elevation: 1,
  },
  segmentText: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontWeight: '600',
  },
  segmentTextActive: { color: colors.text },

  section: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },

  descBlock: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  descHeading: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  descText: {
    color: colors.text2,
    fontSize: type.body + 1,
    lineHeight: 21,
  },
  attendeeText: {
    color: colors.text2,
    fontSize: type.body,
    paddingVertical: 3,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  companyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
  },
  companyPillText: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    fontWeight: '600',
    maxWidth: 200,
  },

  kvCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kvDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },

  segmentBlock: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  segmentHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  segmentSpeaker: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    fontWeight: '700',
  },
  segmentTime: {
    color: colors.text4,
    fontSize: type.meta,
    fontWeight: '500',
  },

  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  rowPressed: { backgroundColor: colors.surface3 },
  personAvatar: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  personAvatarText: {
    color: colors.text2,
    fontSize: 13,
    fontWeight: '700',
  },
  personName: {
    color: colors.text,
    fontSize: type.body + 1,
    fontWeight: '600',
  },
  personMeta: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 2,
  },

  emptyInline: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    paddingVertical: spacing.xl,
  },

  center: { paddingVertical: 60, alignItems: 'center', justifyContent: 'center' },
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
    paddingHorizontal: spacing.xxl,
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
  pressed: { opacity: 0.6 },

  // Note: the `type` keyword on this property collides with the imported `type`
  // alias from theme. Renamed `segmentText` accordingly when used.
})

// Avoid shadowing `type` from theme.
// (Style key `segmentText` above refers to RN style; theme.type is the import.)
