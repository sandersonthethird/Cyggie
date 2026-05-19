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
  fetchContact,
  type ContactDetail,
  type ContactMeetingRef,
} from '../../lib/api/contacts'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

// Contact detail — mirrors the structure of company/[id].tsx (hero + stats
// + segmented Overview/Meetings) so the navigation feel is uniform.
//
// Notable shape differences vs Company detail:
//   • Hero shows the primary company name as a tappable link → /companies/:id
//   • "People" segment is absent (no second-degree contacts model yet); the
//     two segments are Overview + Meetings.

type Segment = 'overview' | 'meetings'

export default function ContactDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const signOut = useAuthStore((s) => s.signOut)
  const [segment, setSegment] = useState<Segment>('overview')

  const query = useQuery({
    queryKey: ['contacts', 'detail', id],
    queryFn: ({ signal }) => fetchContact(id, { signal }),
    enabled: id.length > 0,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const contact = query.data

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(tabs)/contacts')
            }
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {contact?.fullName ?? ''}
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
        {query.isLoading && !contact ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        ) : query.error && !contact ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : contact ? (
          <>
            <Hero contact={contact} />
            <StatsCard contact={contact} />
            <SegmentControl value={segment} onChange={setSegment} />
            {segment === 'overview' && <OverviewSection contact={contact} />}
            {segment === 'meetings' && (
              <MeetingsSection meetings={contact.recentMeetings} />
            )}
            <View style={{ height: spacing.xxl }} />
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

function Hero({ contact }: { contact: ContactDetail }) {
  return (
    <View style={styles.hero}>
      <View style={styles.heroAvatar}>
        <Text style={styles.heroAvatarText}>{initials(contact.fullName)}</Text>
      </View>
      <Text style={styles.heroName} numberOfLines={2}>
        {contact.fullName}
      </Text>
      {(contact.title || contact.primaryCompanyName) && (
        <Pressable
          onPress={() =>
            contact.primaryCompanyId
              ? router.push(`/companies/${contact.primaryCompanyId}`)
              : undefined
          }
          disabled={!contact.primaryCompanyId}
          style={({ pressed }) => [pressed && styles.pressed]}
        >
          <Text style={styles.heroSubtitle}>
            {contact.title ? `${contact.title}` : ''}
            {contact.title && contact.primaryCompanyName ? ' · ' : ''}
            {contact.primaryCompanyName ? (
              <Text style={styles.heroLink}>{contact.primaryCompanyName}</Text>
            ) : null}
          </Text>
        </Pressable>
      )}
      {contact.linkedinHeadline && (
        <Text style={styles.heroHeadline} numberOfLines={2}>
          {contact.linkedinHeadline}
        </Text>
      )}
      <View style={styles.heroLinks}>
        {contact.email && (
          <LinkChip
            icon="mail-outline"
            label="Email"
            onPress={() => void Linking.openURL(`mailto:${contact.email}`)}
          />
        )}
        {contact.phone && (
          <LinkChip
            icon="call-outline"
            label="Call"
            onPress={() => void Linking.openURL(`tel:${contact.phone}`)}
          />
        )}
        {contact.linkedinUrl && (
          <LinkChip
            icon="logo-linkedin"
            label="LinkedIn"
            onPress={() => void Linking.openURL(contact.linkedinUrl!)}
          />
        )}
      </View>
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

function StatsCard({ contact }: { contact: ContactDetail }) {
  const lastMeeting = formatRelativeDay(contact.lastMeetingAt)
  const lastEmail = formatRelativeDay(contact.lastEmailAt)
  return (
    <View style={styles.statsCard}>
      <StatCell label="Last meeting" value={lastMeeting} />
      <View style={styles.statDivider} />
      <StatCell label="Last email" value={lastEmail} />
      <View style={styles.statDivider} />
      <StatCell
        label="Type"
        value={contact.contactType ? humanize(contact.contactType) : '—'}
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
    { key: 'meetings', label: 'Meetings' },
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

function OverviewSection({ contact }: { contact: ContactDetail }) {
  const rows = useMemo(() => {
    const base = [
      { label: 'Title', value: contact.title },
      { label: 'Company', value: contact.primaryCompanyName },
      {
        label: 'Location',
        value:
          contact.city && contact.state
            ? `${contact.city}, ${contact.state}`
            : contact.city ?? contact.state,
      },
      { label: 'Email', value: contact.email },
      { label: 'Phone', value: contact.phone },
      {
        label: 'Type',
        value: contact.contactType ? humanize(contact.contactType) : null,
      },
      {
        label: 'Relationship',
        value: contact.relationshipStrength
          ? humanize(contact.relationshipStrength)
          : null,
      },
      // Investor-specific (only meaningful for contactType === 'investor', but
      // showing whatever's set rather than hiding behind a type check).
      {
        label: 'Investor stage',
        value: contact.investorStage ? humanize(contact.investorStage) : null,
      },
      {
        label: 'Fund size',
        value: contact.fundSize ? formatCurrency(contact.fundSize) : null,
      },
      {
        label: 'Check size',
        value: formatCheckRange(
          contact.typicalCheckSizeMin,
          contact.typicalCheckSizeMax,
        ),
      },
    ]
    return base.filter((r): r is { label: string; value: string } => Boolean(r.value))
  }, [contact])

  return (
    <View style={styles.section}>
      {contact.keyTakeaways && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>Key takeaways</Text>
          <Text style={styles.descText}>{contact.keyTakeaways}</Text>
        </View>
      )}
      {contact.notes && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>Notes</Text>
          <Text style={styles.descText}>{contact.notes}</Text>
        </View>
      )}
      {rows.length === 0 && !contact.keyTakeaways && !contact.notes ? (
        <Text style={styles.emptyInline}>No contact details yet.</Text>
      ) : (
        <View style={styles.kvCard}>
          {rows.map((row, idx) => (
            <View key={row.label}>
              <View style={styles.kvRow}>
                <Text style={styles.kvLabel}>{row.label}</Text>
                <Text style={styles.kvValue} numberOfLines={2}>
                  {row.value}
                </Text>
              </View>
              {idx < rows.length - 1 && <View style={styles.kvDivider} />}
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function MeetingsSection({ meetings }: { meetings: ContactMeetingRef[] }) {
  if (meetings.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>
          No meetings yet. They appear here once you record one and tag this
          person as a speaker.
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {meetings.map((m, idx) => (
          <View key={m.id}>
            <View style={styles.meetingRow}>
              <View style={styles.meetingIconWrap}>
                <Ionicons name="calendar-outline" size={16} color={colors.text2} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.meetingTitle} numberOfLines={1}>
                  {m.title}
                </Text>
                <Text style={styles.meetingMeta}>
                  {formatMeetingDate(m.date)}
                  {m.durationSeconds
                    ? ` · ${formatDuration(m.durationSeconds)}`
                    : ''}
                </Text>
              </View>
            </View>
            {idx < meetings.length - 1 && <View style={styles.kvDivider} />}
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
        : 'Could not load contact'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Contact failed to load</Text>
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

function formatRelativeDay(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days < 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatMeetingDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`
}

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString()}`
}

function formatCheckRange(min: number | null, max: number | null): string | null {
  if (min == null && max == null) return null
  if (min != null && max != null) return `${formatCurrency(min)}—${formatCurrency(max)}`
  return formatCurrency((min ?? max) as number)
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
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
    width: 72,
    height: 72,
    borderRadius: radii.pill,
    backgroundColor: colors.crimsonMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  heroAvatarText: {
    color: colors.crimson,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 0.5,
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
  heroLink: { color: colors.crimson, fontWeight: '600' },
  heroHeadline: {
    color: colors.text2,
    fontSize: type.bodyTight,
    marginTop: 8,
    textAlign: 'center',
    fontStyle: 'italic',
    paddingHorizontal: spacing.md,
  },
  heroLinks: {
    flexDirection: 'row',
    gap: 8,
    marginTop: spacing.md,
    flexWrap: 'wrap',
    justifyContent: 'center',
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
  linkChipText: {
    color: colors.text2,
    fontSize: type.bodyTight,
    fontWeight: '500',
  },

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
  statCell: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 4,
  },
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

  kvCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kvRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    gap: 16,
  },
  kvLabel: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontWeight: '500',
    width: 110,
  },
  kvValue: {
    flex: 1,
    color: colors.text,
    fontSize: type.body + 1,
    fontWeight: '500',
  },
  kvDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.md,
  },

  meetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  meetingIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meetingTitle: {
    color: colors.text,
    fontSize: type.body + 1,
    fontWeight: '600',
  },
  meetingMeta: {
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
})
