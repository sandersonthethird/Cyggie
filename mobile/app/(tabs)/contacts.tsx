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
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import { fetchContacts, type ContactListItem } from '../../lib/api/contacts'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'
import { ScreenHeader } from '../../components/ScreenHeader'

// Contacts tab — M2 read surface. Same shape as Companies (debounced search,
// sortable list, tap → detail). The contacts surface differs in two places:
//   • Sorted by `lastTouchAt`, computed live on the gateway (speaker-tagged +
//     calendar-attendee-email meetings).
//   • Each row shows the contact's primary company name when present, since
//     that's the most useful disambiguator at a glance.

const PAGE_LIMIT = 100
const SEARCH_DEBOUNCE_MS = 250

export default function ContactsTab() {
  const signOut = useAuthStore((s) => s.signOut)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const query = useQuery({
    queryKey: ['contacts', 'list', debouncedQ],
    queryFn: ({ signal }) =>
      fetchContacts({ q: debouncedQ || undefined, limit: PAGE_LIMIT, signal }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const contacts = query.data?.contacts ?? []
  const total = query.data?.total ?? 0

  const headerSubtitle = useMemo(() => {
    if (query.isLoading && !query.data) return 'Loading…'
    if (debouncedQ) return `${contacts.length} match${contacts.length === 1 ? '' : 'es'}`
    return `${total} contact${total === 1 ? '' : 's'}`
  }, [contacts.length, debouncedQ, query.data, query.isLoading, total])

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <ScreenHeader title="Contacts" subtitle={headerSubtitle} />
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
            placeholder="Search by name or email"
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
      ) : contacts.length === 0 ? (
        <EmptyState filtered={debouncedQ.length > 0} />
      ) : (
        <FlatList
          data={contacts}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <ContactRow contact={item} />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={styles.listContent}
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

function ContactRow({ contact }: { contact: ContactListItem }) {
  const lastTouch = formatLastTouch(contact.lastTouchAt)
  const sub = [contact.title, contact.primaryCompanyName].filter(Boolean).join(' · ')
  return (
    <Pressable
      onPress={() => router.push(`/contacts/${contact.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${contact.fullName} — ${lastTouch}`}
    >
      <View style={styles.rowLeading}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(contact.fullName)}</Text>
        </View>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {contact.fullName}
        </Text>
        {sub.length > 0 && (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {sub}
          </Text>
        )}
        <View style={styles.rowMeta}>
          {contact.contactType && <TypeChip contactType={contact.contactType} />}
          <Text style={styles.rowMetaText}>{lastTouch}</Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.text4} />
    </Pressable>
  )
}

function TypeChip({ contactType }: { contactType: string }) {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText}>{humanize(contactType)}</Text>
    </View>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <View style={styles.center}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="people-outline" size={36} color={colors.text4} />
      </View>
      <Text style={styles.emptyTitle}>
        {filtered ? 'No matches' : 'No contacts yet'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {filtered
          ? 'Try a different search.'
          : 'Contacts appear here as you record meetings.'}
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
        : 'Could not load contacts'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Contacts failed to load</Text>
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

function initials(name: string): string {
  const words = name.trim().split(/\s+/).slice(0, 2)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

function humanize(raw: string): string {
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
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.text2,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
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
