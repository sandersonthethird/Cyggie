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
import { useQuery } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  fetchCompany,
  type CompanyDetail,
  type CompanyMeetingRef,
  type CompanyPersonRef,
} from '../../lib/api/companies'
import { fetchNotes, type NoteListItem } from '../../lib/api/notes'
import { fetchMemosForCompany, type MemoListItem } from '../../lib/api/memos'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

// Company detail — WIREFRAME 6.
//
// Composition:
//   • Header bar with back button + company name
//   • Hero: avatar + name + industry/location meta
//   • Stats card (last touch · meeting count · pipeline stage)
//   • Segmented control: Overview | Meetings | People
//   • Each segment is its own scroll section inside the same ScrollView
//
// Read-only. Editing lands in M4 once mobile sync gets the writeWithSync
// hook from the desktop side.

type Segment = 'overview' | 'meetings' | 'memos' | 'notes' | 'people'

export default function CompanyDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const signOut = useAuthStore((s) => s.signOut)
  const [segment, setSegment] = useState<Segment>('overview')

  const query = useQuery({
    queryKey: ['companies', 'detail', id],
    queryFn: ({ signal }) => fetchCompany(id, { signal }),
    enabled: id.length > 0,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const company = query.data

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/companies'))}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {company?.name ?? ''}
          </Text>
          {/* T17b Slice 2 — "Chat about this company" entry point. Disabled
              until company loads (we need name for the session label). */}
          <Pressable
            onPress={() => {
              if (!company) return
              const label = company.name || 'this company'
              router.push({
                pathname: '/chat/[contextKind]/[contextId]',
                params: {
                  contextKind: 'company',
                  contextId: `company:${company.id}`,
                  label,
                },
              })
            }}
            hitSlop={8}
            disabled={!company}
            style={({ pressed }) => [
              styles.backBtn,
              !company && { opacity: 0.4 },
              pressed && styles.pressed,
            ]}
            accessibilityLabel="Chat about this company"
            accessibilityRole="button"
          >
            <Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.text} />
          </Pressable>
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
        {query.isLoading && !company ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        ) : query.error && !company ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : company ? (
          <>
            <Hero company={company} />
            <StatsCard company={company} />
            <SegmentControl value={segment} onChange={setSegment} />
            {segment === 'overview' && <OverviewSection company={company} />}
            {segment === 'meetings' && (
              <MeetingsSection meetings={company.recentMeetings} />
            )}
            {segment === 'memos' && <CompanyMemosSection companyId={id} />}
            {segment === 'notes' && <CompanyNotesSection companyId={id} />}
            {segment === 'people' && <PeopleSection people={company.people} />}
            <View style={{ height: spacing.xxl }} />
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

function Hero({ company }: { company: CompanyDetail }) {
  const subtitleBits = [
    company.industry,
    company.city && company.state
      ? `${company.city}, ${company.state}`
      : company.city ?? company.state,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <View style={styles.hero}>
      <View style={styles.heroAvatar}>
        <Text style={styles.heroAvatarText}>{initials(company.name)}</Text>
      </View>
      <Text style={styles.heroName} numberOfLines={2}>
        {company.name}
      </Text>
      {subtitleBits.length > 0 && (
        <Text style={styles.heroSubtitle}>{subtitleBits}</Text>
      )}
      {(company.websiteUrl || company.linkedinCompanyUrl) && (
        <View style={styles.heroLinks}>
          {company.websiteUrl && (
            <LinkChip
              icon="globe-outline"
              label={domainLabel(company.primaryDomain, company.websiteUrl)}
              onPress={() =>
                openExternal(
                  ensureHttpUrl(company.websiteUrl!),
                  'Website',
                  company.websiteUrl!,
                )
              }
            />
          )}
          {company.linkedinCompanyUrl && (
            <LinkChip
              icon="logo-linkedin"
              label="LinkedIn"
              onPress={() =>
                openExternal(
                  ensureHttpUrl(company.linkedinCompanyUrl!),
                  'LinkedIn',
                  company.linkedinCompanyUrl!,
                )
              }
            />
          )}
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

function StatsCard({ company }: { company: CompanyDetail }) {
  const lastTouch = formatRelativeDay(company.lastTouchAt)
  return (
    <View style={styles.statsCard}>
      <StatCell label="Last touch" value={lastTouch} />
      <View style={styles.statDivider} />
      <StatCell
        label="Meetings"
        value={String(company.meetingCount)}
      />
      <View style={styles.statDivider} />
      <StatCell
        label="Stage"
        value={company.pipelineStage ? humanizeStage(company.pipelineStage) : '—'}
      />
    </View>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCell}>
      <Text style={styles.statValue} numberOfLines={1}>{value}</Text>
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
    { key: 'memos', label: 'Memos' },
    { key: 'notes', label: 'Notes' },
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
            <Text
              style={[styles.segmentText, active && styles.segmentTextActive]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {it.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function OverviewSection({ company }: { company: CompanyDetail }) {
  const rows = useMemo(
    () =>
      [
        { label: 'Industry', value: company.industry },
        { label: 'Stage', value: company.stage },
        {
          label: 'Pipeline',
          value: company.pipelineStage ? humanizeStage(company.pipelineStage) : null,
        },
        { label: 'Round', value: company.round },
        {
          label: 'Raise size',
          value: company.raiseSize ? formatCurrency(company.raiseSize) : null,
        },
        {
          label: 'Total funding',
          value: company.totalFundingRaised
            ? formatCurrency(company.totalFundingRaised)
            : null,
        },
        { label: 'ARR', value: company.arr ? formatCurrency(company.arr) : null },
        {
          label: 'Runway',
          value: company.runwayMonths ? `${company.runwayMonths} months` : null,
        },
        { label: 'Employees', value: company.employeeCountRange },
        {
          label: 'Founded',
          value: company.foundingYear ? String(company.foundingYear) : null,
        },
      ].filter((r): r is { label: string; value: string } => Boolean(r.value)),
    [company],
  )

  return (
    <View style={styles.section}>
      {company.description && (
        <View style={styles.descBlock}>
          <Text style={styles.descText}>{company.description}</Text>
        </View>
      )}
      {rows.length === 0 && !company.description ? (
        <Text style={styles.emptyInline}>No company details yet.</Text>
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

function MeetingsSection({ meetings }: { meetings: CompanyMeetingRef[] }) {
  if (meetings.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>No meetings linked to this company yet.</Text>
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
                  {m.durationSeconds ? ` · ${formatDuration(m.durationSeconds)}` : ''}
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

function CompanyNotesSection({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: ['notes', 'company', companyId],
    queryFn: ({ signal }) => fetchNotes({ companyId, limit: 50, signal }),
    enabled: companyId.length > 0,
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
        <Text style={styles.emptyInline}>No notes for this company yet.</Text>
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {notes.map((n, idx) => (
          <View key={n.id}>
            <CompanyNoteRow note={n} />
            {idx < notes.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

function CompanyNoteRow({ note }: { note: NoteListItem }) {
  const title = note.title?.trim().length
    ? note.title.trim()
    : firstLineOfNote(note.contentPreview)
  const showPreview = note.title?.trim() && note.contentPreview.length > 0
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
          <Text style={styles.meetingMeta}>{formatNoteRelative(note.updatedAt)}</Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text4} />
    </Pressable>
  )
}

function firstLineOfNote(s: string): string {
  const trimmed = s.trim()
  if (trimmed.length === 0) return '(empty note)'
  const nl = trimmed.indexOf('\n')
  return nl === -1 ? trimmed : trimmed.slice(0, nl)
}

function formatNoteRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return new Date(iso).toLocaleDateString()
}

function CompanyMemosSection({ companyId }: { companyId: string }) {
  const query = useQuery({
    queryKey: ['memos', 'company', companyId],
    queryFn: ({ signal }) => fetchMemosForCompany(companyId, { signal }),
    enabled: companyId.length > 0,
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
        <Text style={styles.emptyInline}>Couldn&apos;t load memos. Pull to refresh.</Text>
      </View>
    )
  }

  const memos = query.data ?? []
  if (memos.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>
          Memos are created on desktop. None for this company yet.
        </Text>
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {memos.map((m, idx) => (
          <View key={m.id}>
            <CompanyMemoRow memo={m} companyId={companyId} />
            {idx < memos.length - 1 && <View style={styles.kvDivider} />}
          </View>
        ))}
      </View>
    </View>
  )
}

function CompanyMemoRow({
  memo,
  companyId,
}: {
  memo: MemoListItem
  companyId: string
}) {
  return (
    <Pressable
      onPress={() => router.push(`/companies/${companyId}/memos/${memo.id}`)}
      style={({ pressed }) => [styles.meetingRow, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={memo.title}
    >
      <View style={styles.meetingIconWrap}>
        <Ionicons name="document-outline" size={16} color={colors.text2} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.memoTitleRow}>
          <Text style={styles.meetingTitle} numberOfLines={1}>
            {memo.title}
          </Text>
          <Text style={styles.memoStatusPill}>{memo.status}</Text>
        </View>
        {memo.preview.length > 0 ? (
          <Text style={styles.meetingMeta} numberOfLines={2}>
            {memo.preview}
          </Text>
        ) : (
          <Text style={styles.meetingMeta}>
            {formatNoteRelative(memo.updatedAt)}
          </Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text4} />
    </Pressable>
  )
}

function PeopleSection({ people }: { people: CompanyPersonRef[] }) {
  if (people.length === 0) {
    return (
      <View style={styles.section}>
        <Text style={styles.emptyInline}>No people linked to this company yet.</Text>
      </View>
    )
  }
  return (
    <View style={styles.section}>
      <View style={styles.kvCard}>
        {people.map((p, idx) => (
          <View key={p.id}>
            <Pressable
              onPress={() => router.push(`/contacts/${p.id}`)}
              style={({ pressed }) => [styles.personRow, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={p.fullName}
            >
              <View style={styles.personAvatar}>
                <Text style={styles.personAvatarText}>{initials(p.fullName)}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.personName} numberOfLines={1}>
                  {p.fullName}
                </Text>
                {(p.title || p.email) && (
                  <Text style={styles.personMeta} numberOfLines={1}>
                    {[p.title, p.email].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.text4} />
            </Pressable>
            {idx < people.length - 1 && <View style={styles.kvDivider} />}
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
        : 'Could not load company'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Company failed to load</Text>
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
  } catch {
    Alert.alert(label, fallback)
  }
}

function ensureHttpUrl(raw: string): string {
  const trimmed = raw.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed.replace(/^\/+/, '')}`
}

function domainLabel(primaryDomain: string | null, websiteUrl: string | null): string {
  if (primaryDomain && primaryDomain.trim().length > 0) {
    return primaryDomain.trim().replace(/^www\./i, '')
  }
  if (websiteUrl) {
    try {
      const url = new URL(websiteUrl)
      return url.hostname.replace(/^www\./i, '')
    } catch {
      return websiteUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '')
    }
  }
  return 'Website'
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).slice(0, 2)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

function humanizeStage(raw: string): string {
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
    paddingHorizontal: 2,
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

  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  descBlock: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
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
  memoTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  memoStatusPill: {
    color: colors.text3,
    fontSize: type.caption,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    backgroundColor: colors.surface3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radii.sm,
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

  center: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
