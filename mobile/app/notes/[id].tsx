import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Keyboard,
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
import { Toolbar, type EditorBridge } from '@10play/tentap-editor'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ApiError } from '../../lib/api/client'
import { deleteNote, fetchNote, updateNote, type NoteDetail } from '../../lib/api/notes'
import { useAuthStore } from '../../lib/auth/store'
import { RichMarkdown } from '../../lib/markdown'
import { KeyboardAvoidingScreen } from '../../components/KeyboardAvoidingScreen'
import { NoteTagger } from '../../components/NoteTagger'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { RichNoteEditor, type RichNoteEditorHandle } from '../../components/RichNoteEditor'
import { resolveNoteSaveContent } from '../../lib/notes/save-content'
import { useCreateNote } from '../../lib/notes/use-create-note'
import { colors, radii, spacing, type } from '../../theme'

// M5 PR3 — gate the Tiptap-in-WebView editor. OFF by default until a dev build
// confirms the editor + md round-trip; inlined at JS-bundle time like the other
// EXPO_PUBLIC flags. Flag-off OR an editor crash (ErrorBoundary) falls back to
// the plain TextInput, so note editing never bricks.
const RICH_NOTE_EDITOR_ENABLED =
  process.env['EXPO_PUBLIC_FEATURE_RICH_NOTE_EDITOR'] === '1'

// Note detail — single screen because notes don't have enough cardinality to
// justify a segmented control. Just hero + meta chips + content body.
//
// Cross-link chips at the top (Company / Contact / Source meeting) navigate
// back into the existing detail screens, so a note acts as a hub between
// the three primary entities.

export default function NoteDetailScreen() {
  const params = useLocalSearchParams<{ id: string; new?: string }>()
  const id = typeof params.id === 'string' ? params.id : ''
  // ?new=1 — this note was just created via the Notes-tab + button. Auto-enter
  // edit mode (once) and, if it's abandoned empty, hard-delete it on unmount.
  const isNew = params.new === '1'
  const signOut = useAuthStore((s) => s.signOut)
  const myUserId = useAuthStore((s) => s.userId)
  const queryClient = useQueryClient()
  const { createNewNote, creating } = useCreateNote()

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
  // Entity tags being edited. Names are kept alongside ids so the chip renders
  // immediately from the picker selection (server-truth on the next save).
  const [draftCompanyId, setDraftCompanyId] = useState<string | null>(null)
  const [draftCompanyName, setDraftCompanyName] = useState<string | null>(null)
  const [draftContactId, setDraftContactId] = useState<string | null>(null)
  const [draftContactName, setDraftContactName] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const contentRef = useRef<TextInput>(null)
  // Rich editor (PR3): a ref to extract markdown on save + a dirty flag so an
  // un-edited note is saved VERBATIM (no md↔html round-trip → no corruption).
  // editorRemountKey forces a fresh editor mount after a 409 reseed.
  const editorRef = useRef<RichNoteEditorHandle>(null)
  const [contentDirty, setContentDirty] = useState(false)
  const [editorRemountKey, setEditorRemountKey] = useState(0)
  // The editor bridge, lifted out of RichNoteEditor so the formatting <Toolbar>
  // can render at the SCREEN ROOT (it must float above the keyboard — see
  // RichNoteEditor header). null when not mounted / after a crash fallback.
  const [toolbarEditor, setToolbarEditor] = useState<EditorBridge | null>(null)
  // Measured keyboard height — floats the formatting toolbar exactly at the
  // keyboard top. Explicit offset (NOT a nested KeyboardAvoidingView, which
  // double-shifts against the screen's own KeyboardAvoidingScreen).
  const [kbHeight, setKbHeight] = useState(0)

  const startEditing = (): void => {
    if (!note || !isOwner) return
    setDraftTitle(note.title ?? '')
    setDraftContent(note.content)
    setDraftPrivate(note.isPrivate)
    setDraftCompanyId(note.companyId)
    setDraftCompanyName(note.companyName)
    setDraftContactId(note.contactId)
    setDraftContactName(note.contactName)
    setContentDirty(false)
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
      // Don't-touch-untouched guard (4A) — see resolveNoteSaveContent.
      const content = await resolveNoteSaveContent({
        richEnabled: RICH_NOTE_EDITOR_ENABLED,
        dirty: contentDirty,
        draftContent,
        getMarkdown: editorRef.current ? () => editorRef.current!.getMarkdown() : null,
      })
      const result = await updateNote(
        note.id,
        {
          title: draftTitle.trim() || null,
          content,
          isPrivate: draftPrivate,
          companyId: draftCompanyId,
          contactId: draftContactId,
        },
        Date.now().toString(),
      )
      // PATCH returns the full server-truth NoteDetail (joined company/contact
      // names), so seed the cache with it directly — no client-side merging.
      queryClient.setQueryData<NoteDetail>(['notes', 'detail', note.id], result)
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
          setDraftCompanyId(fresh.data.companyId)
          setDraftCompanyName(fresh.data.companyName)
          setDraftContactId(fresh.data.contactId)
          setDraftContactName(fresh.data.contactName)
          // The rich editor is uncontrolled — force a remount so the reseeded
          // server content actually replaces what's on screen, and clear dirty.
          setEditorRemountKey((k) => k + 1)
          setContentDirty(false)
        }
      } else {
        setEditError(err instanceof Error ? err.message : 'Save failed — please try again')
      }
    } finally {
      setSaving(false)
    }
  }

  // Auto-enter edit mode once for a freshly created note (?new=1). The detail
  // cache was seeded by handleNewNote, so `note` is present on first render and
  // the editor opens with no loading spinner.
  const autoEditedRef = useRef(false)
  useEffect(() => {
    if (isNew && note && isOwner && !editing && !autoEditedRef.current) {
      autoEditedRef.current = true
      startEditing()
    }
    // startEditing is stable for this screen instance; guarded by the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, note, isOwner, editing])

  // Abandoned-empty-note cleanup. On unmount, if this was a fresh note (?new=1)
  // that was never given any content/title/tag (a successful Save updates the
  // cache, so a real note is skipped), hard-delete it so a fat-finger
  // "+ then back out" doesn't leave a permanent empty note.
  //
  //   create ─▶ ?new=1 editor ─┬─ Save (cache has content) ─▶ keep
  //                            └─ back out (cache still empty) ─▶ hard delete
  useEffect(() => {
    return () => {
      if (!isNew) return
      const cached = queryClient.getQueryData<NoteDetail>(['notes', 'detail', id])
      const hasContent =
        !!cached &&
        ((cached.title?.trim().length ?? 0) > 0 ||
          cached.content.trim().length > 0 ||
          cached.companyId != null ||
          cached.contactId != null)
      if (cached && !hasContent) {
        void deleteNote(id, { hard: true }).catch(() => {})
        void queryClient.invalidateQueries({ queryKey: ['notes', 'list'] })
      }
    }
    // Run only on unmount; id/isNew are fixed for this screen instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track keyboard height so the floating toolbar sits at its top. iOS fires the
  // `Will` events (smoother, pre-animation height); Android only the `Did` ones.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', (e) => setKbHeight(e.endCoordinates.height))
    const showAndroid = Keyboard.addListener('keyboardDidShow', (e) => setKbHeight(e.endCoordinates.height))
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbHeight(0))
    const hideAndroid = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0))
    return () => {
      show.remove()
      showAndroid.remove()
      hide.remove()
      hideAndroid.remove()
    }
  }, [])

  return (
    <View style={styles.root}>
      <KeyboardAvoidingScreen style={styles.flex}>
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
          ) : (
            // Compose a NEW note (not edit this one — tap the body to edit).
            // Shown for everyone: a teammate viewing a shared note can still
            // compose their own.
            <Pressable
              onPress={() => void createNewNote()}
              disabled={creating}
              hitSlop={8}
              style={({ pressed }) => [
                styles.backBtn,
                (pressed || creating) && styles.pressed,
              ]}
              accessibilityLabel="New note"
              accessibilityRole="button"
            >
              <Ionicons name="create-outline" size={20} color={colors.text} />
            </Pressable>
          )}
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
              {RICH_NOTE_EDITOR_ENABLED ? (
                <ErrorBoundary
                  // A WebView/editor crash degrades to the plain TextInput —
                  // note editing never bricks. `reset` lets the user retry.
                  fallback={() => (
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
                  )}
                >
                  <RichNoteEditor
                    key={editorRemountKey}
                    ref={editorRef}
                    initialMarkdown={draftContent}
                    onChange={() => setContentDirty(true)}
                    onEditorReady={setToolbarEditor}
                    editable={!saving}
                  />
                </ErrorBoundary>
              ) : (
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
              )}
              {editError ? <Text style={styles.editError}>{editError}</Text> : null}
            </View>

            <View style={styles.privacyRow}>
              <View style={styles.privacyText}>
                <Text style={styles.privacyLabel}>Private</Text>
                <Text style={styles.privacyHint}>
                  {draftPrivate
                    ? 'Only you can see this note.'
                    : draftCompanyId || draftContactId
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

            <NoteTagger
              companyId={draftCompanyId}
              companyName={draftCompanyName}
              contactId={draftContactId}
              contactName={draftContactName}
              disabled={saving}
              onTagCompany={(cid, cname) => {
                setDraftCompanyId(cid)
                setDraftCompanyName(cname)
              }}
              onTagContact={(ctid, ctname) => {
                setDraftContactId(ctid)
                setDraftContactName(ctname)
              }}
            />

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
      </KeyboardAvoidingScreen>

      {/*
        Floating formatting toolbar at the SCREEN ROOT — a sibling of
        KeyboardAvoidingScreen, NOT inside it (that would double-shift it against
        the screen's own keyboard padding). Its `bottom` is the measured keyboard
        height, so it sits exactly at the keyboard top while editing and drops to
        the screen bottom when the keyboard dismisses. hidden={false} keeps it
        visible whenever editing — tentap's focus-gated default never appears
        reliably on-device. Gated on !saving so it isn't live on the read-only
        (editable={!saving}) editor mid-save.
      */}
      {editing && !saving && RICH_NOTE_EDITOR_ENABLED && toolbarEditor ? (
        <View style={[styles.floatingToolbar, { bottom: kbHeight }]} pointerEvents="box-none">
          <Toolbar editor={toolbarEditor} hidden={false} />
        </View>
      ) : null}
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
  flex: { flex: 1 },
  // Screen-root host for the floating tentap toolbar (bottom is set dynamically
  // to the measured keyboard height — see render comment).
  floatingToolbar: { position: 'absolute', left: 0, right: 0 },
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
