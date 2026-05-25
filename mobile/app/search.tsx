import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../lib/api/client'
import {
  searchEverything,
  type CompanyHit,
  type ContactHit,
  type MeetingHit,
  type NoteHit,
  type SearchResponse,
} from '../lib/api/search'
import { useAuthStore } from '../lib/auth/store'
import { CompanyLogo } from '../components/CompanyLogo'
import { colors, radii, spacing, type } from '../theme'

// Universal search overlay.
//
// One typed input → fan-out across all four entities, grouped by type.
// Empty query renders the "type to search" prompt. Each section has a header
// with the total match count; tapping "View all" pushes to the matching tab
// pre-filtered (Notes only for now, since the other tabs would need an
// initial-q query param — TODO once those tabs support it).

const SEARCH_DEBOUNCE_MS = 200
const PER_TYPE_LIMIT = 5

export default function SearchScreen() {
  const signOut = useAuthStore((s) => s.signOut)
  const [input, setInput] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const inputRef = useRef<TextInput>(null)

  // Autofocus on mount — this is a search screen; the keyboard should already
  // be open when the user lands here.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(input.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [input])

  const query = useQuery({
    queryKey: ['search', debouncedQ],
    queryFn: ({ signal }) =>
      searchEverything(debouncedQ, { limit: PER_TYPE_LIMIT, signal }),
    enabled: debouncedQ.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={8}
            style={({ pressed }) => [styles.cancelBtn, pressed && styles.pressed]}
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <View style={styles.searchWrap}>
            <Ionicons
              name="search"
              size={16}
              color={colors.text4}
              style={styles.searchIcon}
            />
            <TextInput
              ref={inputRef}
              value={input}
              onChangeText={setInput}
              placeholder="Search companies, contacts, meetings, notes"
              placeholderTextColor={colors.text4}
              style={styles.searchInput}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {debouncedQ.length < 2 ? (
          <PromptState />
        ) : query.isLoading && !query.data ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        ) : query.error && !query.data ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : query.data ? (
          <Results data={query.data} />
        ) : null}
      </ScrollView>
    </View>
  )
}

function Results({ data }: { data: SearchResponse }) {
  const allEmpty =
    data.companies.items.length === 0 &&
    data.contacts.items.length === 0 &&
    data.meetings.items.length === 0 &&
    data.notes.items.length === 0
  if (allEmpty) {
    return (
      <View style={styles.center}>
        <View style={styles.emptyIconWrap}>
          <Ionicons name="search-outline" size={32} color={colors.text4} />
        </View>
        <Text style={styles.emptyTitle}>No matches</Text>
        <Text style={styles.emptySubtitle}>
          Try a different search across your CRM.
        </Text>
      </View>
    )
  }
  return (
    <>
      <Section
        label="Companies"
        total={data.companies.total}
        shown={data.companies.items.length}
        emptyHidden
      >
        {data.companies.items.map((c) => (
          <CompanyRow key={c.id} hit={c} />
        ))}
      </Section>
      <Section
        label="Contacts"
        total={data.contacts.total}
        shown={data.contacts.items.length}
        emptyHidden
      >
        {data.contacts.items.map((c) => (
          <ContactRow key={c.id} hit={c} />
        ))}
      </Section>
      <Section
        label="Meetings"
        total={data.meetings.total}
        shown={data.meetings.items.length}
        emptyHidden
      >
        {data.meetings.items.map((m) => (
          <MeetingRow key={m.id} hit={m} />
        ))}
      </Section>
      <Section
        label="Notes"
        total={data.notes.total}
        shown={data.notes.items.length}
        emptyHidden
      >
        {data.notes.items.map((n) => (
          <NoteRow key={n.id} hit={n} />
        ))}
      </Section>
    </>
  )
}

function Section({
  label,
  total,
  shown,
  emptyHidden,
  children,
}: {
  label: string
  total: number
  shown: number
  emptyHidden?: boolean
  children: React.ReactNode
}) {
  if (emptyHidden && total === 0) return null
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionHeaderText}>{label}</Text>
        {total > shown && (
          <Text style={styles.sectionHeaderHint}>
            {shown} of {total}
          </Text>
        )}
      </View>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  )
}

function CompanyRow({ hit }: { hit: CompanyHit }) {
  const sub = [hit.industry, hit.pipelineStage ? humanize(hit.pipelineStage) : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <ResultRow
      leading={
        <CompanyLogo
          domain={hit.primaryDomain}
          name={hit.name}
          size={32}
          shape="rounded"
        />
      }
      title={hit.name}
      subtitle={sub || null}
      onPress={() => router.push(`/companies/${hit.id}`)}
    />
  )
}

function ContactRow({ hit }: { hit: ContactHit }) {
  const sub = [hit.title, hit.primaryCompanyName, hit.email]
    .filter(Boolean)
    .join(' · ')
  return (
    <ResultRow
      icon="person-outline"
      title={hit.fullName}
      subtitle={sub || null}
      onPress={() => router.push(`/contacts/${hit.id}`)}
    />
  )
}

function MeetingRow({ hit }: { hit: MeetingHit }) {
  return (
    <ResultRow
      icon="calendar-outline"
      title={hit.title}
      subtitle={formatMeetingDate(hit.date)}
      onPress={() => router.push(`/meetings/${hit.id}`)}
    />
  )
}

function NoteRow({ hit }: { hit: NoteHit }) {
  const title = hit.title?.trim() || hit.contentPreview.slice(0, 60) || 'Untitled note'
  const linked = [hit.companyName, hit.contactName].filter(Boolean).join(' · ')
  return (
    <ResultRow
      icon="document-text-outline"
      title={title}
      subtitle={linked || hit.contentPreview}
      onPress={() => router.push(`/notes/${hit.id}`)}
    />
  )
}

function ResultRow({
  icon,
  leading,
  title,
  subtitle,
  onPress,
}: {
  icon?: keyof typeof Ionicons.glyphMap
  leading?: ReactNode
  title: string
  subtitle: string | null
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {leading ? (
        <View style={styles.rowLeadingWrap}>{leading}</View>
      ) : icon ? (
        <View style={styles.rowIconWrap}>
          <Ionicons name={icon} size={16} color={colors.text2} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text4} />
    </Pressable>
  )
}

function PromptState() {
  return (
    <View style={styles.center}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="search-outline" size={32} color={colors.text4} />
      </View>
      <Text style={styles.emptyTitle}>Search your CRM</Text>
      <Text style={styles.emptySubtitle}>
        Companies, contacts, meetings, and notes — all in one query.
      </Text>
    </View>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Search failed'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Search failed</Text>
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

function humanize(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatMeetingDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cancelBtn: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface3,
    borderRadius: radii.md,
    paddingHorizontal: 12,
    height: 38,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: type.body + 1,
    paddingVertical: 0,
  },

  scroll: { paddingBottom: 80, backgroundColor: colors.bg },

  section: { paddingTop: spacing.md },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: 6,
  },
  sectionHeaderText: {
    color: colors.text4,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  sectionHeaderHint: {
    color: colors.text4,
    fontSize: type.meta,
    fontWeight: '500',
  },
  sectionCard: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowPressed: { backgroundColor: colors.surface3 },
  rowIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLeadingWrap: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: {
    color: colors.text,
    fontSize: type.body + 1,
    fontWeight: '600',
  },
  rowSubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 2,
  },

  center: {
    paddingVertical: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    paddingHorizontal: spacing.xxl,
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
