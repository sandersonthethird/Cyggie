import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  fetchContact,
  updateContact,
  type ContactDetail,
  type ContactMeetingRef,
} from '../../lib/api/contacts'
import { fetchNotes, type NoteListItem } from '../../lib/api/notes'
import { useAuthStore } from '../../lib/auth/store'
import { CompanyLogo } from '../../components/CompanyLogo'
import { KeyboardAvoidingScreen } from '../../components/KeyboardAvoidingScreen'
import { UserNoteEditor } from '../../components/UserNoteEditor'
import { LedgerCard, linkedinPath, type LedgerGroup, type PillTone } from '../../components/LedgerCard'
import { RichMarkdown } from '../../lib/markdown'
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
    <KeyboardAvoidingScreen style={styles.root}>
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
          {/* T17b Slice 2 — "Chat about this contact" entry point. Disabled
              until contact loads (we need fullName for the session label). */}
          <Pressable
            onPress={() => {
              if (!contact) return
              const label = contact.fullName || 'this contact'
              router.push({
                pathname: '/chat/[contextKind]/[contextId]',
                params: {
                  contextKind: 'contact',
                  contextId: `contact:${contact.id}`,
                  label,
                },
              })
            }}
            hitSlop={8}
            disabled={!contact}
            style={({ pressed }) => [
              styles.backBtn,
              !contact && { opacity: 0.4 },
              pressed && styles.pressed,
            ]}
            accessibilityLabel="Chat about this contact"
            accessibilityRole="button"
          >
            <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.text} />
          </Pressable>
        </View>
      </SafeAreaView>

      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
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
            {segment === 'overview' && (
              <>
                <OverviewSection contact={contact} />
                <ContactNotesSection contactId={contact.id} />
              </>
            )}
            {segment === 'meetings' && (
              <MeetingsSection meetings={contact.recentMeetings} />
            )}
            <View style={{ height: spacing.xxl }} />
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingScreen>
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
          style={({ pressed }) => [styles.heroAffiliation, pressed && styles.pressed]}
        >
          {contact.primaryCompanyName && (
            <CompanyLogo
              domain={contact.primaryCompanyDomain}
              name={contact.primaryCompanyName}
              size={20}
              shape="rounded"
            />
          )}
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
            onPress={() => openEmail(contact.email!)}
          />
        )}
        {contact.phone && (
          <LinkChip
            icon="call-outline"
            label="Call"
            onPress={() => openExternal(`tel:${contact.phone}`, 'Phone', contact.phone!)}
          />
        )}
        {contact.linkedinUrl && (
          <LinkChip
            icon="logo-linkedin"
            label="LinkedIn"
            onPress={() => openExternal(contact.linkedinUrl!, 'LinkedIn', contact.linkedinUrl!)}
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
  const lastTouch = formatRelativeDay(contact.lastTouchAt)
  return (
    <View style={styles.statsCard}>
      <StatCell label="Last touch" value={lastTouch} />
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
  const groups = useMemo<LedgerGroup[]>(() => {
    const location =
      contact.city && contact.state
        ? `${contact.city}, ${contact.state}`
        : contact.city ?? contact.state

    const about: LedgerGroup['rows'] = [
      contact.title ? { key: 'Title', value: contact.title } : null,
      contact.primaryCompanyName ? { key: 'Company', value: contact.primaryCompanyName } : null,
      contact.email ? { key: 'Email', value: contact.email } : null,
      contact.phone ? { key: 'Phone', value: contact.phone } : null,
      contact.linkedinUrl
        ? { key: 'LinkedIn', value: linkedinPath(contact.linkedinUrl), link: true }
        : null,
      location ? { key: 'Location', value: location } : null,
      contact.street ? { key: 'Street', value: contact.street } : null,
      contact.postalCode ? { key: 'Postal Code', value: contact.postalCode } : null,
      contact.country ? { key: 'Country', value: contact.country } : null,
    ].filter((r): r is NonNullable<typeof r> => r !== null)

    // Investor-specific — group drops out entirely when nothing is set.
    const typeTone: PillTone = contact.contactType === 'investor' ? 'green' : 'neutral'
    const checkSize = formatCheckRange(
      contact.typicalCheckSizeMin,
      contact.typicalCheckSizeMax,
    )
    const investment: LedgerGroup['rows'] = [
      contact.contactType
        ? {
            key: 'Type',
            pills: [{ label: humanize(contact.contactType), tone: typeTone }],
          }
        : null,
      contact.relationshipStrength
        ? {
            key: 'Relationship',
            pills: [{ label: humanize(contact.relationshipStrength), tone: 'sky' as const }],
          }
        : null,
      contact.fundSize ? { key: 'Fund size', value: formatCurrency(contact.fundSize) } : null,
      checkSize ? { key: 'Check size', value: checkSize } : null,
    ].filter((r): r is NonNullable<typeof r> => r !== null)

    return [
      { label: 'About', rows: about },
      { label: 'Investment', rows: investment },
    ].filter((g) => g.rows.length > 0)
  }, [contact])

  const queryClient = useQueryClient()
  const saveUserNote = async (next: string | null): Promise<void> => {
    await updateContact(contact.id, { keyTakeawaysUserNote: next }, Date.now().toString())
    queryClient.setQueryData<ContactDetail>(
      ['contacts', 'detail', contact.id],
      (prev) => prev ? { ...prev, keyTakeawaysUserNote: next } : prev,
    )
  }

  return (
    <View style={styles.section}>
      {/* Key Takeaways block — user note (editable) + AI bullets (read-only on mobile). */}
      <View style={styles.descBlock}>
        <Text style={styles.descHeading}>Key takeaways</Text>
        <UserNoteEditor
          value={contact.keyTakeawaysUserNote}
          onSave={saveUserNote}
        />
        {contact.keyTakeaways && (
          <View style={{ marginTop: spacing.sm }}>
            <RichMarkdown>{contact.keyTakeaways}</RichMarkdown>
          </View>
        )}
      </View>
      {contact.notes && (
        <View style={styles.descBlock}>
          <Text style={styles.descHeading}>Notes</Text>
          <RichMarkdown>{contact.notes}</RichMarkdown>
        </View>
      )}
      {groups.length === 0 && !contact.notes ? (
        <Text style={styles.emptyInline}>No contact details yet.</Text>
      ) : (
        <LedgerCard groups={groups} />
      )}
    </View>
  )
}

// Firm-shared notes feed for this contact — the collective-memory surface
// mirroring CompanyNotesSection. Each firm member's tagged, non-private notes
// on this contact appear here, attributed; a header counts firm vs yours.
function ContactNotesSection({ contactId }: { contactId: string }) {
  const myUserId = useAuthStore((s) => s.userId)
  const query = useQuery({
    queryKey: ['notes', 'contact', contactId],
    queryFn: ({ signal }) => fetchNotes({ contactId, limit: 50, signal }),
    enabled: contactId.length > 0,
    staleTime: 30_000,
  })

  if (query.isLoading && !query.data) {
    return (
      <View style={styles.section}>
        <ActivityIndicator color={colors.crimson} />
      </View>
    )
  }
  if (query.error) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>Couldn&apos;t load notes. Pull to refresh.</Text>
      </View>
    )
  }

  const notes = query.data?.notes ?? []
  if (notes.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.descHeading}>Notes</Text>
        <Text style={styles.emptyInline}>No notes for this contact yet.</Text>
      </View>
    )
  }

  const mine = myUserId ? notes.filter((n) => n.authorUserId === myUserId).length : 0
  const summary =
    mine < notes.length
      ? `${notes.length} firm · ${mine} yours`
      : `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`

  return (
    <View style={styles.section}>
      <Text style={styles.notesSummary}>{summary}</Text>
      <View style={styles.kvCard}>
        {notes.map((n, idx) => (
          <View key={n.id}>
            <ContactNoteRow note={n} myUserId={myUserId} />
            {idx < notes.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

function ContactNoteRow({ note, myUserId }: { note: NoteListItem; myUserId: string | null }) {
  const title = note.title?.trim().length ? note.title.trim() : note.contentPreview || 'Untitled note'
  const showPreview = note.title?.trim() && note.contentPreview.length > 0
  const teammate = !!myUserId && note.authorUserId !== myUserId
  return (
    <Pressable
      onPress={() => router.push(`/notes/${note.id}`)}
      style={({ pressed }) => [styles.meetingRow, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.meetingIconWrap}>
        {note.isPinned ? (
          <Ionicons name="bookmark" size={16} color={colors.crimson} />
        ) : (
          <Ionicons name="document-text-outline" size={16} color={colors.text2} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.meetingTitle} numberOfLines={1}>
          {title}
        </Text>
        {showPreview ? (
          <Text style={styles.meetingMeta} numberOfLines={2}>
            {note.contentPreview}
          </Text>
        ) : (
          <Text style={styles.meetingMeta}>{formatRelativeDay(note.updatedAt)}</Text>
        )}
        {teammate ? (
          <Text style={styles.noteAuthor} numberOfLines={1}>
            Shared by {note.authorName ?? 'a teammate'}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text4} />
    </Pressable>
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
            <Pressable
              onPress={() => router.push(`/meetings/${m.id}`)}
              style={({ pressed }) => [styles.meetingRow, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={m.title}
            >
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
              <Ionicons name="chevron-forward" size={16} color={colors.text4} />
            </Pressable>
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

async function openExternal(url: string, label: string, fallback: string) {
  try {
    await Linking.openURL(url)
  } catch (err) {
    if (__DEV__) console.warn(`[openExternal] failed to open ${url}`, err)
    Alert.alert(label, fallback)
  }
}

// Prefers Gmail if installed; falls back to mailto: (which on iOS opens
// whatever the user set as the system default mail app — Apple Mail,
// Outlook, or Gmail if they've configured it as default). Plain mailto:
// alone ignored Gmail for users who hadn't toggled iOS's default-app
// setting, so Apple Mail was opening even when Gmail was the obvious
// pick. openURL rejects when the scheme isn't installed, so the catch
// is the install-check.
async function openEmail(email: string) {
  const gmail = `googlegmail:///co?to=${encodeURIComponent(email)}`
  try {
    await Linking.openURL(gmail)
    return
  } catch {
    // Gmail not installed — fall through.
  }
  try {
    await Linking.openURL(`mailto:${email}`)
  } catch (err) {
    if (__DEV__) console.warn('[openEmail] failed', err)
    Alert.alert('Email', email)
  }
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
  flex: { flex: 1 },
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
  heroAffiliation: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  heroSubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
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

  meetingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  rowPressed: { backgroundColor: colors.surface3 },
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
  noteAuthor: {
    color: colors.crimson,
    fontSize: type.meta,
    fontWeight: '600',
    marginTop: 3,
  },
  notesSummary: {
    color: colors.text4,
    fontSize: type.meta,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
    marginLeft: 2,
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
