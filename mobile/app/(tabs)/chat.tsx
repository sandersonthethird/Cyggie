import { useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useQuery } from '@tanstack/react-query'

import {
  type ChatContextKind,
  type ChatSessionListItem,
  createOrGetChatSession,
  fetchChatSessions,
} from '../../lib/api/chat'
import { ChatComposer, type ChatComposerHandle } from '../../components/ChatComposer'
import { useStartNewChat } from '../../components/useStartNewChat'
import { colors, radii, spacing, type } from '../../theme'

// T17b Slice 2 — Chat tab is the global ('crm') chat surface. The composer
// lives in <ChatComposer />; this screen owns the tab-nav appbar + the
// past-chats sheet that lets the user jump back to prior threads on any
// context kind.

const CRM_CONTEXT_KIND: ChatContextKind = 'crm'
const CRM_CONTEXT_ID = 'crm:global'
const CRM_CONTEXT_LABEL = 'Ask Cyggie'

export default function ChatTab(): React.JSX.Element {
  const [pastChatsOpen, setPastChatsOpen] = useState(false)
  const composerRef = useRef<ChatComposerHandle | null>(null)

  // Shares cache with ChatComposer via identical query key — TanStack
  // dedupes the request. Used here for messageCount + sessionId so the
  // New Chat pencil knows when to no-op / disable.
  const sessionQuery = useQuery({
    queryKey: ['chat', 'session-by-context', CRM_CONTEXT_KIND, CRM_CONTEXT_ID],
    queryFn: () =>
      createOrGetChatSession({
        contextKind: CRM_CONTEXT_KIND,
        contextId: CRM_CONTEXT_ID,
        contextLabel: CRM_CONTEXT_LABEL,
      }),
    staleTime: 60_000,
  })

  const messageCount = sessionQuery.data?.messageCount ?? 0
  const startNew = useStartNewChat({
    sessionId: sessionQuery.data?.id,
    contextKind: CRM_CONTEXT_KIND,
    contextId: CRM_CONTEXT_ID,
    messageCount,
    abortInflight: () => composerRef.current?.abortInflight(),
  })

  const newChatDisabled =
    sessionQuery.isLoading || startNew.isPending || messageCount === 0

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
      <View style={styles.appbar}>
        <View style={styles.appbarRow}>
          <View style={styles.appbarTitleWrap}>
            <Text style={styles.title}>Ask Cyggie</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              Global chat about your portfolio + pipeline
            </Text>
          </View>
          <Pressable
            onPress={() => startNew.mutate()}
            hitSlop={8}
            disabled={newChatDisabled}
            style={({ pressed }) => [
              styles.pastBtn,
              newChatDisabled && styles.iconDisabled,
              pressed && !newChatDisabled && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Start new chat"
            accessibilityState={{ disabled: newChatDisabled }}
          >
            <Ionicons name="create-outline" size={22} color={colors.text} />
          </Pressable>
          <Pressable
            onPress={() => setPastChatsOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.pastBtn, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Past chats"
          >
            <Ionicons name="time-outline" size={22} color={colors.text} />
          </Pressable>
        </View>
      </View>

      <ChatComposer
        ref={composerRef}
        contextKind={CRM_CONTEXT_KIND}
        contextId={CRM_CONTEXT_ID}
        contextLabel={CRM_CONTEXT_LABEL}
      />

      <PastChatsSheet open={pastChatsOpen} onClose={() => setPastChatsOpen(false)} />
    </SafeAreaView>
  )
}

// ─── Past-chats sheet ──────────────────────────────────────────────────────

function PastChatsSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const listQuery = useQuery({
    queryKey: ['chat', 'sessions-list', { includeArchived: false }],
    queryFn: ({ signal }) =>
      fetchChatSessions({ includeArchived: false, limit: 50 }, { signal }),
    enabled: open,
    staleTime: 30_000,
  })

  return (
    <Modal visible={open} animationType="fade" transparent onRequestClose={onClose}>
      <View style={sheetStyles.backdrop}>
        <View style={sheetStyles.card}>
          <View style={sheetStyles.header}>
            <Text style={sheetStyles.title}>Past chats</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={({ pressed }) => [sheetStyles.close, pressed && styles.pressed]}
              accessibilityLabel="Close past chats"
              accessibilityRole="button"
            >
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={sheetStyles.list}>
            {listQuery.isLoading ? (
              <View style={sheetStyles.center}>
                <ActivityIndicator color={colors.crimson} />
              </View>
            ) : listQuery.error ? (
              <View style={sheetStyles.center}>
                <Text style={styles.errorText}>
                  {listQuery.error.message ?? 'Failed to load chats.'}
                </Text>
              </View>
            ) : (listQuery.data?.sessions ?? []).length === 0 ? (
              <View style={sheetStyles.center}>
                <Text style={sheetStyles.emptyText}>No chats yet.</Text>
              </View>
            ) : (
              (listQuery.data?.sessions ?? []).map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  onPress={() => {
                    onClose()
                    // Special-case the global crm chat — it's the current
                    // tab; don't push a duplicate copy on top of itself.
                    if (s.contextKind === 'crm' && s.contextId === CRM_CONTEXT_ID) return
                    const kind = (s.contextKind || 'crm') as ChatContextKind
                    router.push({
                      pathname: '/chat/[contextKind]/[contextId]',
                      params: {
                        contextKind: kind,
                        contextId: s.contextId,
                        label: s.title ?? s.contextLabel ?? 'Chat',
                      },
                    })
                  }}
                />
              ))
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function SessionRow({
  session,
  onPress,
}: {
  session: ChatSessionListItem
  onPress: () => void
}): React.JSX.Element {
  const label = session.title ?? session.contextLabel ?? 'Untitled chat'
  const kindIcon = iconForKind(session.contextKind)
  const when = formatRelativeTime(session.lastMessageAt)
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [sheetStyles.row, pressed && { backgroundColor: colors.surface3 }]}
      accessibilityRole="button"
      accessibilityLabel={`Open chat: ${label}`}
    >
      <View style={sheetStyles.rowIconWrap}>
        <Ionicons name={kindIcon} size={18} color={colors.text3} />
      </View>
      <View style={sheetStyles.rowText}>
        <Text style={sheetStyles.rowTitle} numberOfLines={1}>
          {label}
        </Text>
        <Text style={sheetStyles.rowMeta} numberOfLines={1}>
          {labelForKind(session.contextKind)}
          {session.messageCount > 0 ? ` · ${session.messageCount} msg` : ''}
          {when ? ` · ${when}` : ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.text4} />
    </Pressable>
  )
}

function iconForKind(kind: string): keyof typeof Ionicons.glyphMap {
  switch (kind) {
    case 'meeting':
      return 'calendar-outline'
    case 'company':
      return 'business-outline'
    case 'contact':
      return 'person-outline'
    case 'search-results':
      return 'search-outline'
    case 'crm':
    default:
      return 'chatbubbles-outline'
  }
}

function labelForKind(kind: string): string {
  switch (kind) {
    case 'meeting':
      return 'Meeting'
    case 'company':
      return 'Company'
    case 'contact':
      return 'Contact'
    case 'search-results':
      return 'Search'
    case 'crm':
      return 'Global'
    default:
      return kind
  }
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const delta = Date.now() - then
  if (delta < 0) return 'just now'
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  pressed: { opacity: 0.6 },

  appbar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  appbarRow: { flexDirection: 'row', alignItems: 'center' },
  appbarTitleWrap: { flex: 1 },
  title: { color: colors.text, fontSize: type.display, fontWeight: '700' },
  subtitle: { color: colors.text3, fontSize: type.meta, marginTop: 2 },
  pastBtn: {
    width: 36,
    height: 36,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDisabled: { opacity: 0.35 },

  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
})

const sheetStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    maxHeight: '80%',
    paddingBottom: spacing.lg,
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
  close: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  list: { paddingVertical: spacing.sm },
  center: { padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  rowIconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.md,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowTitle: { color: colors.text, fontSize: type.body + 1, fontWeight: '600' },
  rowMeta: { color: colors.text3, fontSize: type.meta, marginTop: 2 },
})
