import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import { fetchNote, updateNote, type NoteDetail } from '../../lib/api/notes'
import { useAuthStore } from '../../lib/auth/store'
import { RichMarkdown } from '../../lib/markdown'
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
  const myUserId = useAuthStore((s) => s.userId)
  const queryClient = useQueryClient()

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
  // A note is the viewer's own iff they authored it. Only the owner may edit or
  // toggle privacy — teammates can read a shared note but the gateway PATCH is
  // owner-scoped (would 404), so we hide the edit affordance for them.
  const isOwner = !!note && !!myUserId && note.authorUserId === myUserId

  // ── Edit mode ──────────────────────────────────────────────────────────
  // Tap the pencil → title + body become TextInputs with Save/Cancel. Saves
  // go through PATCH /notes/:id with a Date.now() lamport (LWW). On a 409
  // (the note changed on another device) we refetch and ask the user to retry
  // so their edit is reconciled against the latest server copy rather than
  // silently clobbering it.
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [draftPrivate, setDraftPrivate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const contentRef = useRef<TextInput>(null)

  const startEditing = (): void => {
    if (!note || !isOwner) return
    setDraftTitle(note.title ?? '')
    setDraftContent(note.content)
    setDraftPrivate(note.isPrivate)
    setEditError(null)
    setEditing(true)
    setTimeout(() => contentRef.current?.focus(), 50)
  }

  const cancelEditing = (): void => {
    setEditing(false)
    setEditError(null)
  }

  const saveEdits = async (): Promise<void> => {
    if (!note) return
    setSaving(true)
    setEditError(null)
    try {
      const result = await updateNote(
        note.id,
        { title: draftTitle.trim() || null, content: draftContent, isPrivate: draftPrivate },
        Date.now().toString(),
      )
      queryClient.setQueryData<NoteDetail>(['notes', 'detail', note.id], (prev) =>
        prev
          ? {
              ...prev,
              title: result.title,
              content: result.content,
              isPinned: result.isPinned,
              isPrivate: result.isPrivate,
              updatedAt: result.updatedAt,
            }
          : prev,
      )
      // Refresh the Notes tab list so the preview/title/ordering update too.
      void queryClient.invalidateQueries({ queryKey: ['notes', 'list'] })
      setEditing(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setEditError('This note changed on another device. Refreshed — re-apply your edits.')
        const fresh = await query.refetch()
        // Reseed drafts from the latest server copy so the user edits the
        // current version rather than overwriting it blindly.
        if (fresh.data) {
          setDraftTitle(fresh.data.title ?? '')
          setDraftContent(fresh.data.content)
        }
      } else {
        setEditError(err instanceof Error ? err.message : 'Save failed — please try again')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          {editing ? (
            <Pressable
              onPress={cancelEditing}
              disabled={saving}
              hitSlop={8}
              style={({ pressed }) => [styles.topbarAction, pressed && styles.pressed]}
              accessibilityLabel="Cancel editing"
              accessibilityRole="button"
            >
              <Text style={styles.topbarActionText}>Cancel</Text>
            </Pressable>
          ) : (
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
          )}
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {note?.title?.trim() || 'Note'}
          </Text>
          {editing ? (
            <Pressable
              onPress={saveEdits}
              disabled={saving}
              hitSlop={8}
              style={({ pressed }) => [
                styles.topbarAction,
                (pressed || saving) && styles.pressed,
              ]}
              accessibilityLabel="Save note"
              accessibilityRole="button"
            >
              {saving ? (
                <ActivityIndicator color={colors.crimson} />
              ) : (
                <Text style={[styles.topbarActionText, styles.topbarSave]}>Save</Text>
              )}
            </Pressable>
          ) : note && isOwner ? (
            <Pressable
              onPress={startEditing}
              hitSlop={8}
              style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
              accessibilityLabel="Edit note"
              accessibilityRole="button"
            >
              <Ionicons name="create-outline" size={20} color={colors.text} />
            </Pressable>
          ) : (
            <View style={styles.backBtn} />
          )}
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
        ) : note && editing ? (
          <>
            <View style={styles.headerBlock}>
              <TextInput
                value={draftTitle}
                onChangeText={setDraftTitle}
                placeholder="Title"
                placeholderTextColor={colors.text4}
                style={styles.titleInput}
                maxLength={500}
                editable={!saving}
              />
            </View>

            <View style={styles.contentBlock}>
              <TextInput
                ref={contentRef}
                value={draftContent}
                onChangeText={setDraftContent}
                placeholder="Write your note…"
                placeholderTextColor={colors.text4}
                style={styles.contentInput}
                multiline
                editable={!saving}
              />
              {editError ? <Text style={styles.editError}>{editError}</Text> : null}
            </View>

            <View style={styles.privacyRow}>
              <View style={styles.privacyText}>
                <Text style={styles.privacyLabel}>Private</Text>
                <Text style={styles.privacyHint}>
                  {draftPrivate
                    ? 'Only you can see this note.'
                    : note.companyId || note.contactId
                      ? 'Visible to your firm because it’s tagged.'
                      : 'Only you — tag a company or contact to share it.'}
                </Text>
              </View>
              <Switch
                value={draftPrivate}
                onValueChange={setDraftPrivate}
                disabled={saving}
                trackColor={{ true: colors.crimson, false: colors.surface3 }}
              />
            </View>

            <View style={{ height: spacing.xxl }} />
          </>
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
              <VisibilityBadge note={note} isOwner={isOwner} />
              <LinkedChips note={note} />
            </View>

            <Pressable style={styles.contentBlock} onPress={startEditing}>
              {note.content.trim().length === 0 ? (
                <Text style={styles.emptyInline}>This note is empty. Tap to edit.</Text>
              ) : (
                <RichMarkdown>{note.content}</RichMarkdown>
              )}
            </Pressable>

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

// Glanceable "who can see this" affordance. Owner sees their own note's
// effective visibility ("Only you" vs "Visible to your firm"); a teammate's
// shared note shows its author ("Shared by …").
function VisibilityBadge({ note, isOwner }: { note: NoteDetail; isOwner: boolean }) {
  if (!isOwner) {
    return (
      <View style={[styles.visBadge, styles.visShared]}>
        <Ionicons name="people-outline" size={12} color={colors.crimson} />
        <Text style={[styles.visText, styles.visTextShared]} numberOfLines={1}>
          Shared by {note.authorName ?? 'a teammate'}
        </Text>
      </View>
    )
  }
  const tagged = !!note.companyId || !!note.contactId
  const firmVisible = tagged && !note.isPrivate
  return (
    <View style={styles.visBadge}>
      <Ionicons
        name={firmVisible ? 'people-outline' : 'lock-closed-outline'}
        size={12}
        color={colors.text4}
      />
      <Text style={styles.visText}>{firmVisible ? 'Visible to your firm' : 'Only you'}</Text>
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
  topbarAction: {
    minWidth: 56,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
  },
  topbarActionText: { color: colors.text3, fontSize: type.bodyTight, fontWeight: '500' },
  topbarSave: { color: colors.crimson, fontWeight: '700' },
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
  titleInput: {
    color: colors.text,
    fontSize: type.h1,
    fontWeight: '700',
    letterSpacing: -0.4,
    padding: 0,
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

  visBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginTop: 8,
  },
  visShared: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
  },
  visText: {
    color: colors.text4,
    fontSize: type.meta,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  visTextShared: { color: colors.crimson, maxWidth: 220 },

  privacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    backgroundColor: colors.surface,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  privacyText: { flex: 1 },
  privacyLabel: { color: colors.text, fontSize: type.body, fontWeight: '600' },
  privacyHint: { color: colors.text3, fontSize: type.bodyTight, marginTop: 2 },

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
  emptyInline: {
    color: colors.text3,
    fontSize: type.bodyTight,
    fontStyle: 'italic',
  },
  contentInput: {
    color: colors.text,
    fontSize: type.body,
    minHeight: 240,
    textAlignVertical: 'top',
    padding: 0,
  },
  editError: {
    color: colors.rec,
    fontSize: type.bodyTight,
    marginTop: spacing.md,
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
