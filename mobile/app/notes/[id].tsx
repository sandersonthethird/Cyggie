import { useEffect } from 'react'
import {
  ActivityIndicator,
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
import { fetchNote, type NoteDetail } from '../../lib/api/notes'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

// Note detail — single screen because notes don't have enough cardinality to
// justify a segmented control. Just hero + meta chips + content body.
//
// Cross-link chips at the top (Company / Contact / Source meeting) navigate
// back into the existing detail screens, so a note acts as a hub between
// the three primary entities.

export default function NoteDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  const signOut = useAuthStore((s) => s.signOut)

  const query = useQuery({
    queryKey: ['notes', 'detail', id],
    queryFn: ({ signal }) => fetchNote(id, { signal }),
    enabled: id.length > 0,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (query.error instanceof ApiError && query.error.reauthRequired) {
      void signOut().then(() => router.replace('/(auth)/sign-in'))
    }
  }, [query.error, signOut])

  const note = query.data

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(tabs)/notes')
            }
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {note?.title?.trim() || 'Note'}
          </Text>
          <View style={styles.backBtn}>
            {note?.isPinned ? (
              <Ionicons name="bookmark" size={18} color={colors.crimson} />
            ) : null}
          </View>
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
        {query.isLoading && !note ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.crimson} />
          </View>
        ) : query.error && !note ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        ) : note ? (
          <>
            <View style={styles.headerBlock}>
              <Text style={styles.title}>
                {note.title?.trim() || 'Untitled note'}
              </Text>
              <Text style={styles.timestamp}>
                Updated {formatDateLong(note.updatedAt)}
              </Text>
              {note.folderPath ? (
                <View style={styles.folderRow}>
                  <Ionicons name="folder-outline" size={12} color={colors.text4} />
                  <Text style={styles.folderText}>{note.folderPath}</Text>
                </View>
              ) : null}
              <LinkedChips note={note} />
            </View>

            <View style={styles.contentBlock}>
              {note.content.trim().length === 0 ? (
                <Text style={styles.emptyInline}>This note is empty.</Text>
              ) : (
                <Text style={styles.content}>{note.content}</Text>
              )}
            </View>

            {note.importSource ? (
              <Text style={styles.provenance}>
                Imported from {humanize(note.importSource)}
              </Text>
            ) : null}

            <View style={{ height: spacing.xxl }} />
          </>
        ) : null}
      </ScrollView>
    </View>
  )
}

function LinkedChips({ note }: { note: NoteDetail }) {
  const chips: Array<{ icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }> = []
  if (note.companyId && note.companyName) {
    chips.push({
      icon: 'business-outline',
      label: note.companyName,
      onPress: () => router.push(`/companies/${note.companyId}`),
    })
  }
  if (note.contactId && note.contactName) {
    chips.push({
      icon: 'person-outline',
      label: note.contactName,
      onPress: () => router.push(`/contacts/${note.contactId}`),
    })
  }
  if (note.sourceMeetingId && note.sourceMeetingTitle) {
    chips.push({
      icon: 'calendar-outline',
      label: note.sourceMeetingTitle,
      onPress: () => router.push(`/meetings/${note.sourceMeetingId}`),
    })
  }
  if (chips.length === 0) return null
  return (
    <View style={styles.chipRow}>
      {chips.map((c, i) => (
        <Pressable
          key={i}
          onPress={c.onPress}
          style={({ pressed }) => [styles.linkedChip, pressed && styles.pressed]}
        >
          <Ionicons name={c.icon} size={12} color={colors.crimson} />
          <Text style={styles.linkedChipText} numberOfLines={1}>
            {c.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message =
    error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Could not load note'
  return (
    <View style={styles.center}>
      <Text style={styles.errorTitle}>Note failed to load</Text>
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

function formatDateLong(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
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

  headerBlock: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: type.h1,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  timestamp: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: 6,
  },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 8,
  },
  folderText: {
    color: colors.text4,
    fontSize: type.meta,
    fontWeight: '500',
    letterSpacing: 0.2,
  },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: spacing.md,
  },
  linkedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
  },
  linkedChipText: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    fontWeight: '600',
    maxWidth: 200,
  },

  contentBlock: {
    backgroundColor: colors.surface,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  content: {
    color: colors.text2,
    fontSize: type.body + 2,
    lineHeight: 22,
  },
  emptyInline: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontStyle: 'italic',
  },

  provenance: {
    color: colors.text4,
    fontSize: type.meta,
    textAlign: 'center',
    marginTop: spacing.lg,
    fontStyle: 'italic',
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
