import { useEffect, useRef, useState, type RefObject } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  type ChatContextKind,
  type ChatMessage,
  type ChatSessionListItem,
  createOrGetChatSession,
  fetchChatSession,
  updateChatSession,
} from '../../../lib/api/chat'
import { ChatComposer, type ChatComposerHandle } from '../../../components/ChatComposer'
import { CompanyRecentChats } from '../../../components/CompanyRecentChats'
import { useStartNewChat } from '../../../components/useStartNewChat'
import { colors, radii, spacing, type } from '../../../theme'

// T17b Slice 1 — per-entity chat surface. Mounted from meeting / contact /
// company detail screens via `router.push('/chat/<kind>/<contextId>?label=<...>')`.
//
// This screen owns the stack-nav topbar (back button + actions kebab) and
// the rename + actions sheets. The composer lives in <ChatComposer />.
//
// Session-data sharing: this screen and the composer both call
// useQuery(['chat', 'session-by-context', kind, id]) — TanStack dedupes by
// key, so the screen reads the same cached session for its title +
// actions sheet without coordination.

const KINDS: Record<string, ChatContextKind> = {
  meeting: 'meeting',
  company: 'company',
  contact: 'contact',
  crm: 'crm',
  'search-results': 'search-results',
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    contextKind: string
    contextId: string
    label?: string
    sessionId?: string
  }>()

  const contextKind = KINDS[params.contextKind ?? '']
  const contextId = params.contextId ?? ''
  const contextLabel = (Array.isArray(params.label) ? params.label[0] : params.label) ?? null
  // Resume mode: opened to a SPECIFIC prior chat by id (from a recent-chats
  // row or the global past-chats sheet) rather than the context's active
  // session. Drives the header/actions from that session's detail and hides
  // the recent-chats section so the screen is a clean single-chat view.
  const resumeSessionId =
    (Array.isArray(params.sessionId) ? params.sessionId[0] : params.sessionId) || undefined
  const isResume = Boolean(resumeSessionId)

  // Stack-pushed screen with no tab bar — pad the bottom by the home-indicator
  // inset so the composer doesn't bleed off the screen on devices with one.
  const insets = useSafeAreaInsets()

  // Default mode: find-or-create the active session. Shares cache with
  // ChatComposer via identical query key.
  const contextSessionQuery = useQuery({
    queryKey: ['chat', 'session-by-context', contextKind, contextId],
    queryFn: () =>
      createOrGetChatSession({
        contextKind: contextKind as ChatContextKind,
        contextId,
        ...(contextLabel != null ? { contextLabel } : {}),
      }),
    enabled: Boolean(contextKind && contextId) && !isResume,
    staleTime: 60_000,
  })

  // Resume mode: load the specific session's detail (shares cache with the
  // composer's detailQuery — same key — so they dedupe).
  const detailQuery = useQuery({
    queryKey: ['chat', 'session-detail', resumeSessionId],
    queryFn: ({ signal }) => fetchChatSession(resumeSessionId!, { signal }),
    enabled: isResume,
    staleTime: 15_000,
  })

  const session = isResume ? detailQuery.data?.session : contextSessionQuery.data
  const headerTitle = session?.title ?? session?.contextLabel ?? contextLabel ?? 'Chat'

  // Recent-chats section: company default-entry only (hidden in resume mode).
  // Starts expanded; collapses on first send so it stops taking space.
  const [recentCollapsed, setRecentCollapsed] = useState(false)
  const showRecentChats = contextKind === 'company' && !isResume

  // T17b Slice 3 — session actions sheet (Rename / Pin / Archive / Start new chat).
  const [actionsOpen, setActionsOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')

  // Forwarded to ChatComposer + into SessionActionsSheet so "Start new
  // chat" can abort any in-flight LLM stream before archiving the
  // session — see useStartNewChat's abortInflight callback.
  const composerRef = useRef<ChatComposerHandle | null>(null)

  if (!contextKind || !contextId) {
    return (
      <View style={[styles.root, { paddingBottom: insets.bottom }]}>
        <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
          <View style={styles.topbar}>
            <Pressable
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
              hitSlop={8}
              style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            >
              <Ionicons name="chevron-back" size={22} color={colors.text} />
            </Pressable>
            <Text style={styles.topbarTitle}>Chat</Text>
            <View style={styles.backBtn} />
          </View>
        </SafeAreaView>
        <View style={styles.center}>
          <Text style={styles.errorText}>Missing chat context.</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom }]}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle} numberOfLines={1}>
            {headerTitle}
          </Text>
          {/* T17b Slice 3 — kebab opens an action sheet for rename / pin /
              archive. Disabled until the session row has loaded (we need
              the current state to know if "Pin" or "Unpin" should show). */}
          <Pressable
            onPress={() => session && setActionsOpen(true)}
            hitSlop={8}
            disabled={!session}
            style={({ pressed }) => [
              styles.backBtn,
              !session && { opacity: 0.4 },
              pressed && styles.pressed,
            ]}
            accessibilityLabel="Chat actions"
            accessibilityRole="button"
          >
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.text} />
          </Pressable>
        </View>
      </SafeAreaView>

      {session && (
        <SessionActionsSheet
          open={actionsOpen}
          session={session}
          composerRef={composerRef}
          resumeMode={isResume}
          onClose={() => setActionsOpen(false)}
          onRename={() => {
            setActionsOpen(false)
            setRenameDraft(session.title ?? '')
            setRenameOpen(true)
          }}
        />
      )}
      {session && (
        <RenameModal
          open={renameOpen}
          initialValue={renameDraft}
          onClose={() => setRenameOpen(false)}
          sessionId={session.id}
          contextKind={contextKind as ChatContextKind}
          rawContextId={contextId}
        />
      )}

      {showRecentChats && (
        <CompanyRecentChats
          contextId={contextId}
          currentSessionId={contextSessionQuery.data?.id}
          collapsed={recentCollapsed}
          onToggle={() => setRecentCollapsed((c) => !c)}
        />
      )}

      <ChatComposer
        ref={composerRef}
        contextKind={contextKind as ChatContextKind}
        contextId={contextId}
        contextLabel={contextLabel}
        sessionId={resumeSessionId}
        onMessageSent={showRecentChats ? () => setRecentCollapsed(true) : undefined}
      />
    </View>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────────

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
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  topbarTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: type.body,
    fontWeight: '600',
    color: colors.text,
    marginHorizontal: spacing.sm,
  },
  center: { padding: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
})

// ─── Session actions sheet ────────────────────────────────────────────────
//
// T17b Slice 3 — Rename / Pin/Unpin / Archive. Bottom-sheet-style Modal
// matching the past-chats sheet on the Chat tab. Each row calls
// updateChatSession, which mints a lamport + PATCHes the gateway. The
// 200/409 outcome bubbles up via the api-client `ok` flag — on conflict
// we currently just toast the message; a future polish modal can present
// the server's authoritative state for reconciliation.

function SessionActionsSheet({
  open,
  session,
  composerRef,
  resumeMode = false,
  onClose,
  onRename,
}: {
  open: boolean
  session: ChatSessionListItem
  composerRef: RefObject<ChatComposerHandle | null>
  /** True when this screen was opened by resuming a specific past chat. In
   *  that mode the screen is pinned to a fixed sessionId, so after "Start new
   *  chat" archives it we must navigate back to the default (find-or-create)
   *  company chat — otherwise the screen would keep showing the just-archived
   *  session and the button would appear to do nothing. */
  resumeMode?: boolean
  onClose: () => void
  onRename: () => void
}): React.JSX.Element {
  const qc = useQueryClient()

  const startNew = useStartNewChat({
    sessionId: session.id,
    contextKind: session.contextKind as ChatContextKind,
    contextId: session.contextId,
    messageCount: session.messageCount,
    abortInflight: () => composerRef.current?.abortInflight(),
    onStarted: () => {
      onClose()
      if (resumeMode) {
        // Drop the sessionId param → default mode → fresh/active session.
        router.replace({
          pathname: '/chat/[contextKind]/[contextId]',
          params: {
            contextKind: session.contextKind,
            contextId: session.contextId,
            label: session.title ?? session.contextLabel ?? 'Chat',
          },
        })
      }
    },
  })

  const togglePinMut = useMutation({
    mutationFn: () => updateChatSession(session.id, { isPinned: !session.isPinned }),
    onSuccess: (result) => {
      if (result.ok && result.session) {
        qc.setQueryData(
          ['chat', 'session-detail', session.id],
          (prev: { session: ChatSessionListItem; messages: ChatMessage[] } | undefined) =>
            prev ? { ...prev, session: result.session! } : prev,
        )
        qc.invalidateQueries({ queryKey: ['chat', 'sessions-list'] })
        onClose()
      } else if (!result.ok) {
        Alert.alert(
          session.isPinned ? 'Unpin failed' : 'Pin failed',
          'Someone else just changed this chat. Pull to refresh and try again.',
        )
      }
    },
    onError: () => {
      Alert.alert('Action failed', 'Please try again.')
    },
  })

  const toggleCacheMut = useMutation({
    mutationFn: () =>
      updateChatSession(session.id, { cacheEnabled: !session.cacheEnabled }),
    onSuccess: (result) => {
      if (result.ok && result.session) {
        qc.setQueryData(
          ['chat', 'session-detail', session.id],
          (prev: { session: ChatSessionListItem; messages: ChatMessage[] } | undefined) =>
            prev ? { ...prev, session: result.session! } : prev,
        )
        qc.invalidateQueries({ queryKey: ['chat', 'sessions-list'] })
        onClose()
      } else if (!result.ok) {
        Alert.alert(
          'Update failed',
          'Someone else just changed this chat. Pull to refresh and try again.',
        )
      }
    },
    onError: () => {
      Alert.alert('Action failed', 'Please try again.')
    },
  })

  const archiveMut = useMutation({
    mutationFn: () => updateChatSession(session.id, { isArchived: true }),
    onSuccess: (result) => {
      if (result.ok) {
        qc.invalidateQueries({ queryKey: ['chat', 'sessions-list'] })
        qc.invalidateQueries({
          queryKey: ['chat', 'session-by-context', session.contextKind, session.contextId],
        })
        onClose()
        // Drop the user off the now-archived screen — staying on it would
        // be confusing because the next visit to this entity will spin up
        // a fresh active session anyway.
        if (router.canGoBack()) router.back()
        else router.replace('/')
      } else {
        Alert.alert(
          'Archive failed',
          'Someone else just changed this chat. Pull to refresh and try again.',
        )
      }
    },
    onError: () => {
      Alert.alert('Action failed', 'Please try again.')
    },
  })

  const confirmArchive = (): void => {
    Alert.alert(
      'Archive this chat?',
      'Archived chats stay in your history but won’t appear in the recent list. A new chat for this context will start fresh next time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Archive', style: 'destructive', onPress: () => archiveMut.mutate() },
      ],
    )
  }

  const busy =
    togglePinMut.isPending ||
    archiveMut.isPending ||
    startNew.isPending ||
    toggleCacheMut.isPending

  return (
    <Modal visible={open} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={actionsSheetStyles.backdrop} onPress={onClose}>
        <Pressable style={actionsSheetStyles.card} onPress={() => undefined}>
          <View style={actionsSheetStyles.header}>
            <Text style={actionsSheetStyles.title}>Chat actions</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
              accessibilityLabel="Close"
              accessibilityRole="button"
            >
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <ActionRow
            icon="create-outline"
            label="Rename"
            disabled={busy}
            onPress={onRename}
          />
          <ActionRow
            icon="add-circle-outline"
            label="Start new chat"
            disabled={busy || session.messageCount === 0}
            onPress={() => startNew.mutate()}
            pending={startNew.isPending}
          />
          <ActionRow
            icon={session.isPinned ? 'pin' : 'pin-outline'}
            label={session.isPinned ? 'Unpin' : 'Pin'}
            disabled={busy}
            onPress={() => togglePinMut.mutate()}
            pending={togglePinMut.isPending}
          />
          <ActionRow
            icon={session.cacheEnabled ? 'flash' : 'flash-outline'}
            label={
              session.cacheEnabled
                ? 'Prompt caching: On'
                : 'Prompt caching: Off'
            }
            disabled={busy}
            onPress={() => toggleCacheMut.mutate()}
            pending={toggleCacheMut.isPending}
          />
          <ActionRow
            icon="archive-outline"
            label="Archive"
            destructive
            disabled={busy}
            onPress={confirmArchive}
            pending={archiveMut.isPending}
          />
        </Pressable>
      </Pressable>
    </Modal>
  )
}

function ActionRow({
  icon,
  label,
  onPress,
  destructive = false,
  disabled = false,
  pending = false,
}: {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  destructive?: boolean
  disabled?: boolean
  pending?: boolean
}): React.JSX.Element {
  const fg = destructive ? colors.crimson : colors.text
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        actionsSheetStyles.row,
        pressed && { backgroundColor: colors.surface3 },
        disabled && { opacity: 0.5 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={actionsSheetStyles.rowIcon}>
        {pending ? (
          <ActivityIndicator size="small" color={fg} />
        ) : (
          <Ionicons name={icon} size={20} color={fg} />
        )}
      </View>
      <Text style={[actionsSheetStyles.rowLabel, { color: fg }]}>{label}</Text>
    </Pressable>
  )
}

// ─── Rename modal ─────────────────────────────────────────────────────────
//
// Simple inline TextInput in a centered card. Native Modal's alert prompt
// (RN's Alert.prompt) is iOS-only; we use a portable Modal instead so the
// rename flow doesn't degrade on Android.

function RenameModal({
  open,
  initialValue,
  onClose,
  sessionId,
  contextKind,
  rawContextId,
}: {
  open: boolean
  initialValue: string
  onClose: () => void
  sessionId: string
  contextKind: ChatContextKind
  rawContextId: string
}): React.JSX.Element {
  const qc = useQueryClient()
  const [value, setValue] = useState(initialValue)

  // When the modal opens with a new initial (e.g. user reopened after a
  // rename), reset the field so the prior session's title doesn't bleed
  // through.
  useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  const renameMut = useMutation({
    mutationFn: (next: string) => updateChatSession(sessionId, { title: next }),
    onSuccess: (result) => {
      if (result.ok && result.session) {
        qc.setQueryData(
          ['chat', 'session-detail', sessionId],
          (prev: { session: ChatSessionListItem; messages: ChatMessage[] } | undefined) =>
            prev ? { ...prev, session: result.session! } : prev,
        )
        qc.setQueryData(
          ['chat', 'session-by-context', contextKind, rawContextId],
          result.session,
        )
        qc.invalidateQueries({ queryKey: ['chat', 'sessions-list'] })
        onClose()
      } else {
        Alert.alert(
          'Rename failed',
          'Someone else just changed this chat. Pull to refresh and try again.',
        )
      }
    },
    onError: () => {
      Alert.alert('Rename failed', 'Please try again.')
    },
  })

  const onSave = (): void => {
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed === initialValue.trim()) {
      onClose()
      return
    }
    renameMut.mutate(trimmed)
  }

  return (
    <Modal visible={open} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable style={renameStyles.backdrop} onPress={onClose}>
        <Pressable style={renameStyles.card} onPress={() => undefined}>
          <Text style={renameStyles.title}>Rename chat</Text>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="Chat title"
            placeholderTextColor={colors.text4}
            style={renameStyles.input}
            autoFocus
            maxLength={200}
            editable={!renameMut.isPending}
            onSubmitEditing={onSave}
            returnKeyType="done"
          />
          <View style={renameStyles.btnRow}>
            <Pressable
              onPress={onClose}
              disabled={renameMut.isPending}
              style={({ pressed }) => [
                renameStyles.btn,
                renameStyles.btnSecondary,
                pressed && styles.pressed,
              ]}
            >
              <Text style={renameStyles.btnSecondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onSave}
              disabled={renameMut.isPending || value.trim().length === 0}
              style={({ pressed }) => [
                renameStyles.btn,
                renameStyles.btnPrimary,
                (renameMut.isPending || value.trim().length === 0) && { opacity: 0.5 },
                pressed && styles.pressed,
              ]}
            >
              {renameMut.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={renameStyles.btnPrimaryText}>Save</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const actionsSheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingBottom: spacing.xl,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { flex: 1, color: colors.text, fontSize: type.h2, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  rowIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowLabel: { fontSize: type.body + 1, fontWeight: '500' },
})

const renameStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: '100%',
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: type.h2, fontWeight: '700' },
  input: {
    backgroundColor: colors.surface3,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.text,
    fontSize: type.body + 1,
  },
  btnRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  btn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.lg,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSecondary: { backgroundColor: 'transparent' },
  btnSecondaryText: { color: colors.text3, fontSize: type.body + 1, fontWeight: '600' },
  btnPrimary: { backgroundColor: colors.crimson },
  btnPrimaryText: { color: '#fff', fontSize: type.body + 1, fontWeight: '600' },
})

