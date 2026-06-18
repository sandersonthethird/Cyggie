import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import {
  flattenCompaniesPages,
  useCompaniesInfiniteQuery,
  type CompanyListItem,
} from '../../lib/api/companies'
import { useAuthStore } from '../../lib/auth/store'
import { CompanyLogo } from '../../components/CompanyLogo'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { colors, radii, spacing, type } from '../../theme'
import { ScreenHeader } from '../../components/ScreenHeader'

// Companies tab — M2 read-only surface.
//
// • Search bar at top (debounced 250ms) → ?q=<substring> on the gateway.
// • FlatList of companies sorted gateway-side: recently-touched first, then the
//   meeting-less tail by newest-created (so just-added companies are reachable).
// • Infinite scroll (useCompaniesInfiniteQuery) — pages of COMPANIES_PAGE_LIMIT
//   appended on scroll-end, so all of a firm's companies are browsable.
// • Tap a row → push /companies/:id detail screen.
// • Pull-to-refresh, empty + error states.

const SEARCH_DEBOUNCE_MS = 250

// Thin wrapper: an ErrorBoundary placed OUTSIDE the screen component so it can
// catch render errors thrown in CompaniesTabInner's OWN body (a boundary inside
// the returned JSX can't catch its parent's render). Reuses ErrorState as the
// fallback; reset() remounts the inner, which re-runs the query. The
// flattenCompaniesPages helper already prevents the known stale-cache crash —
// this is defense-in-depth so any future render throw degrades to a visible,
// recoverable error instead of silently quitting the app.
export default function CompaniesTab() {
  return (
    <ErrorBoundary
      fallback={(error, reset) => <ErrorState error={error} onRetry={reset} />}
    >
      <CompaniesTabInner />
    </ErrorBoundary>
  )
}

function CompaniesTabInner() {
  const signOut = useAuthStore((s) => s.signOut)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const query = useCompaniesInfiniteQuery({ q: debouncedQ || undefined })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  // Tolerant of a stale/old-shaped persisted cache entry — see
  // flattenCompaniesPages. (Previously `query.data?.pages[0]?.total` threw
  // `undefined[0]` when an old `{companies,total}` entry rehydrated, silently
  // crashing the tab on mount.)
  const { companies, total } = useMemo(
    () => flattenCompaniesPages(query.data),
    [query.data],
  )

  const headerSubtitle = useMemo(() => {
    if (query.isLoading && !query.data) return 'Loading…'
    if (debouncedQ) return `${companies.length} match${companies.length === 1 ? '' : 'es'}`
    return `${total} compan${total === 1 ? 'y' : 'ies'}`
  }, [companies.length, debouncedQ, query.data, query.isLoading, total])

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <ScreenHeader title="Companies" subtitle={headerSubtitle} />
        <View style={styles.searchWrap}>
          <Ionicons
            name="search"
            size={16}
            color={colors.text4}
            style={styles.searchIcon}
          />
          <TextInput
            value={searchInput}
            onChangeText={setSearchInput}
            placeholder="Search companies"
            placeholderTextColor={colors.text4}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      </SafeAreaView>

      {query.isLoading && !query.data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.crimson} />
        </View>
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : companies.length === 0 ? (
        <EmptyState filtered={debouncedQ.length > 0} />
      ) : (
        <FlatList
          data={companies}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <CompanyRow company={item} />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) {
              void query.fetchNextPage()
            }
          }}
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <View style={styles.footerSpinner}>
                <ActivityIndicator color={colors.crimson} />
              </View>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => query.refetch()}
              tintColor={colors.crimson}
            />
          }
        />
      )}
    </View>
  )
}

function CompanyRow({ company }: { company: CompanyListItem }) {
  const lastTouch = formatLastTouch(company.lastTouchAt)
  const subtitleBits = [company.industry, company.city && company.state ? `${company.city}, ${company.state}` : company.city ?? company.state]
    .filter(Boolean)
    .join(' · ')
  return (
    <Pressable
      onPress={() => router.push(`/companies/${company.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${company.name} — ${lastTouch}`}
    >
      <View style={styles.rowLeading}>
        <CompanyLogo
          domain={company.primaryDomain}
          name={company.name}
          size={40}
          shape="rounded"
        />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {company.name}
        </Text>
        {subtitleBits.length > 0 && (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitleBits}
          </Text>
        )}
        <View style={styles.rowMeta}>
          {company.pipelineStage && <PipelineChip stage={company.pipelineStage} />}
          <Text style={styles.rowMetaText}>
            {lastTouch}
            {company.meetingCount > 0
              ? ` · ${company.meetingCount} meeting${company.meetingCount === 1 ? '' : 's'}`
              : ''}
          </Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.text4} />
    </Pressable>
  )
}

function PipelineChip({ stage }: { stage: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{humanizeStage(stage)}</Text>
    </View>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <View style={styles.center}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="business-outline" size={36} color={colors.text4} />
      </View>
      <Text style={styles.emptyTitle}>
        {filtered ? 'No matches' : 'No companies yet'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {filtered
          ? 'Try a different search.'
          : 'Companies appear here as you record meetings.'}
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
        : 'Could not load companies'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Companies failed to load</Text>
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

function formatLastTouch(iso: string | null): string {
  if (!iso) return 'No meetings yet'
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days < 0) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function humanizeStage(raw: string): string {
  return raw.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
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

  listContent: { paddingBottom: 140, backgroundColor: colors.bg },
  footerSpinner: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 16 + 40 + 12 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    gap: 12,
  },
  rowPressed: { backgroundColor: colors.surface3 },
  rowLeading: { width: 40 },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: {
    color: colors.text,
    fontSize: type.body + 2,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  rowSubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 2,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  rowMetaText: {
    color: colors.text4,
    fontSize: type.meta + 0.5,
    fontWeight: '500',
  },

  chip: {
    backgroundColor: colors.crimsonMuted,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  chipText: {
    color: colors.crimson,
    fontSize: type.label,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  center: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    alignItems: 'center',
    justifyContent: 'center',
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
  emptySubtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
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
