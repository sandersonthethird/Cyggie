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
import {
  fetchNoteFolders,
  fetchNotes,
  NOTES_INBOX_SENTINEL,
  type NoteListItem,
} from '../../lib/api/notes'
import { NotesFolderPicker } from '../../components/NotesFolderPicker'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

// Notes tab — M2 read surface for the unified notes table.
//
// Default sort (gateway): pinned DESC → updatedAt DESC.
// Filter chips: All / Untagged + a Folders picker (All folders / Inbox /
// specific folder path). When a folder is selected, the list narrows to
// that folder; sort stays pinned-then-recent.

const PAGE_LIMIT = 100
const SEARCH_DEBOUNCE_MS = 250

type FilterMode = 'all' | 'untagged'

export default function NotesTab() {
  const signOut = useAuthStore((s) => s.signOut)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  // folderSelection: null = no folder filter, NOTES_INBOX_SENTINEL = Inbox,
  // string = exact folder path. Drives the gateway `folderPath` param.
  const [folderSelection, setFolderSelection] = useState<string | null>(null)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  const query = useQuery({
    queryKey: ['notes', 'list', debouncedQ, filterMode, folderSelection],
    queryFn: ({ signal }) =>
      fetchNotes({
        q: debouncedQ || undefined,
        untagged: filterMode === 'untagged' ? true : undefined,
        folderPath: folderSelection ?? undefined,
        limit: PAGE_LIMIT,
        signal,
      }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  const foldersQuery = useQuery({
    queryKey: ['notes', 'folders'],
    queryFn: ({ signal }) => fetchNoteFolders({ signal }),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const notes = query.data?.notes ?? []
  const total = query.data?.total ?? 0

  const headerSubtitle = useMemo(() => {
    if (query.isLoading && !query.data) return 'Loading…'
    if (debouncedQ) return `${notes.length} match${notes.length === 1 ? '' : 'es'}`
    return `${total} note${total === 1 ? '' : 's'}`
  }, [debouncedQ, notes.length, query.data, query.isLoading, total])

  const folderChipLabel = folderSelectionLabel(folderSelection)

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.appbar}>
          <View style={styles.appbarTitleWrap}>
            <Text style={styles.appbarTitle}>Notes</Text>
            <Text style={styles.appbarSubtitle}>{headerSubtitle}</Text>
          </View>
        </View>
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
            placeholder="Search notes"
            placeholderTextColor={colors.text4}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
        <View style={styles.filterRow}>
          <FolderChip
            label={folderChipLabel}
            active={folderSelection !== null}
            onPress={() => setFolderPickerOpen(true)}
          />
          <FilterChip
            label="All"
            active={filterMode === 'all'}
            onPress={() => setFilterMode('all')}
          />
          <FilterChip
            label="Untagged"
            active={filterMode === 'untagged'}
            onPress={() => setFilterMode('untagged')}
          />
        </View>
      </SafeAreaView>

      {query.isLoading && !query.data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.crimson} />
        </View>
      ) : query.error && !query.data ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : notes.length === 0 ? (
        <EmptyState
          filtered={
            debouncedQ.length > 0 ||
            filterMode === 'untagged' ||
            folderSelection !== null
          }
        />
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(n) => n.id}
          renderItem={({ item }) => <NoteRow note={item} />}
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

      <NotesFolderPicker
        open={folderPickerOpen}
        folders={foldersQuery.data?.folders ?? []}
        inboxCount={foldersQuery.data?.inboxCount ?? 0}
        totalCount={foldersQuery.data?.totalCount ?? 0}
        selection={folderSelection}
        isLoading={foldersQuery.isLoading}
        onSelect={(sel) => {
          setFolderSelection(sel)
          setFolderPickerOpen(false)
        }}
        onDismiss={() => setFolderPickerOpen(false)}
      />
    </View>
  )
}

function folderSelectionLabel(selection: string | null): string {
  if (selection === null) return 'All folders'
  if (selection === NOTES_INBOX_SENTINEL) return 'Inbox'
  // Show only the leaf segment so the chip doesn't blow out the row width
  // for deep paths like "Investments/AI Infrastructure/Init Labs".
  const segments = selection.split('/')
  return segments[segments.length - 1] ?? selection
}

function FolderChip({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Folder filter: ${label}`}
      style={({ pressed }) => [
        styles.filterChip,
        styles.folderChip,
        active && styles.filterChipActive,
        pressed && styles.pressed,
      ]}
    >
      <Ionicons
        name={active ? 'folder' : 'folder-outline'}
        size={13}
        color={active ? colors.crimson : colors.text3}
      />
      <Text
        style={[styles.filterChipText, active && styles.filterChipTextActive]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <Ionicons
        name="chevron-down"
        size={12}
        color={active ? colors.crimson : colors.text3}
      />
    </Pressable>
  )
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string
  active: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.filterChip,
        active && styles.filterChipActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  )
}

function NoteRow({ note }: { note: NoteListItem }) {
  const title =
    note.title?.trim().length
      ? note.title.trim()
      : firstLineOf(note.contentPreview)
  const linked = [note.companyName, note.contactName].filter(Boolean).join(' · ')
  const showPreviewBelowTitle = note.title?.trim() && note.contentPreview.length > 0
  return (
    <Pressable
      onPress={() => router.push(`/notes/${note.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={title}
    >
      <View style={styles.rowLeading}>
        {note.isPinned ? (
          <Ionicons name="bookmark" size={16} color={colors.crimson} />
        ) : (
          <Ionicons name="document-text-outline" size={18} color={colors.text4} />
        )}
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {title}
        </Text>
        {showPreviewBelowTitle && (
          <Text style={styles.rowSubtitle} numberOfLines={2}>
            {note.contentPreview}
          </Text>
        )}
        <View style={styles.rowMeta}>
          {linked && <Text style={styles.rowLinked}>{linked}</Text>}
          <Text style={styles.rowMetaText}>{formatRelative(note.updatedAt)}</Text>
        </View>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.text4} />
    </Pressable>
  )
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <View style={styles.center}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="document-text-outline" size={36} color={colors.text4} />
      </View>
      <Text style={styles.emptyTitle}>
        {filtered ? 'No matches' : 'No notes yet'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {filtered
          ? 'Try a different filter or search.'
          : 'Notes you capture on desktop appear here.'}
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
        : 'Could not load notes'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Notes failed to load</Text>
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

function firstLineOf(s: string): string {
  if (!s) return 'Untitled note'
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}

function formatRelative(iso: string): string {
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day}d ago`
  if (day < 30) return `${Math.floor(day / 7)}w ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },

  appbar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  appbarTitleWrap: { flex: 1, minWidth: 0 },
  appbarTitle: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.6,
    lineHeight: 28,
  },
  appbarSubtitle: {
    color: colors.text3,
    fontSize: type.meta + 1,
    fontWeight: '500',
    marginTop: 2,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
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

  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    alignItems: 'center',
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
  },
  filterChipActive: { backgroundColor: colors.crimsonMuted },
  filterChipText: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontWeight: '600',
  },
  filterChipTextActive: { color: colors.crimson },
  folderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
  },

  listContent: { paddingBottom: 140, backgroundColor: colors.bg },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.lg + 30,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    gap: 12,
  },
  rowPressed: { backgroundColor: colors.surface3 },
  rowLeading: { width: 26, alignItems: 'center', marginTop: 2 },
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
    marginTop: 4,
    lineHeight: 18,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  rowLinked: {
    color: colors.crimson,
    fontSize: type.meta + 0.5,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  rowMetaText: {
    color: colors.text4,
    fontSize: type.meta + 0.5,
    fontWeight: '500',
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
