import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-native-markdown-display'

import {
  type ChatContextKind,
  type ChatMessage as ChatMessageRow,
  type ChatSessionListItem,
  createOrGetChatSession,
  fetchChatSession,
  fetchChatSessions,
  sendSessionMessage,
} from '../../lib/api/chat'
import { colors, radii, spacing, type } from '../../theme'

// T17b Slice 2 — Chat tab is the global ('crm') chat surface. Same
// session machinery as the per-entity screen, with one fixed context
// (`crm:global`). The appbar also hosts a "past chats" affordance — a
// modal listing every session across context kinds so the user can find
// + jump back to prior threads without first navigating to the entity
// they were chatting about.
//
// Cross-references the implementation in
// mobile/app/chat/[contextKind]/[contextId].tsx — both screens use the
// same TanStack query keys + optimistic-append pattern. A future refactor
// could DRY them into a shared <ChatSessionView/> component; for V1 they
// stay parallel because the appbar + past-chats sheet on this tab is the
// only divergence.

const CRM_CONTEXT_KIND: ChatContextKind = 'crm'
const CRM_CONTEXT_ID = 'crm:global'
const CRM_CONTEXT_LABEL = 'Ask Cyggie'

interface PendingMessage {
  clientId: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

export default function ChatTab(): React.JSX.Element {
  const qc = useQueryClient()
  const scrollRef = useRef<ScrollView | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [pastChatsOpen, setPastChatsOpen] = useState(false)

  // Session find-or-create — idempotent + cheap to retry.
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

  const sessionId = sessionQuery.data?.id

  const detailQuery = useQuery({
    queryKey: ['chat', 'session-detail', sessionId],
    queryFn: ({ signal }) => fetchChatSession(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    staleTime: 15_000,
  })

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('Session not ready')
      return sendSessionMessage(sessionId, { content })
    },
    onMutate: (content) => {
      const userPending: PendingMessage = {
        clientId: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        content,
      }
      const assistantPending: PendingMessage = {
        clientId: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: '',
        pending: true,
      }
      setPending((prev) => [...prev, userPending, assistantPending])
      setInput('')
    },
    onSuccess: (result) => {
      if (result.ok) {
        setPending([])
        if (sessionId) {
          qc.invalidateQueries({ queryKey: ['chat', 'session-detail', sessionId] })
        }
      } else {
        // 409 reconcile — same minimum behavior as the per-entity screen.
        setPending([])
        if (sessionId) {
          qc.setQueryData(['chat', 'session-detail', sessionId], result.conflict)
        }
      }
    },
    onError: () => {
      setPending((prev) =>
        prev.map((m) =>
          m.role === 'assistant' && m.pending
            ? { ...m, pending: false, content: '_(failed to send — tap to retry)_' }
            : m,
        ),
      )
    },
  })

  const messages = useMemo<Array<ChatMessageRow | PendingMessage>>(() => {
    const server = detailQuery.data?.messages ?? []
    return [...server, ...pending]
  }, [detailQuery.data?.messages, pending])

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true })
  }, [messages.length])

  const onSend = (): void => {
    const trimmed = input.trim()
    if (!trimmed || sendMut.isPending || !sessionId) return
    sendMut.mutate(trimmed)
  }

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

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 92 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          {sessionQuery.isLoading || detailQuery.isLoading ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.crimson} />
            </View>
          ) : sessionQuery.error || detailQuery.error ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>
                {(sessionQuery.error ?? detailQuery.error)?.message ?? 'Failed to load chat.'}
              </Text>
            </View>
          ) : messages.length === 0 ? (
            <EmptyState />
          ) : (
            messages.map((m, idx) => <MessageBubble key={messageKey(m, idx)} message={m} />)
          )}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="Ask anything…"
            placeholderTextColor={colors.text4}
            style={styles.input}
            multiline
            editable={!sendMut.isPending && Boolean(sessionId)}
            returnKeyType="send"
            blurOnSubmit
            onSubmitEditing={onSend}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={onSend}
            disabled={sendMut.isPending || input.trim().length === 0 || !sessionId}
            style={({ pressed }) => [
              styles.sendBtn,
              (sendMut.isPending || input.trim().length === 0 || !sessionId) &&
                styles.sendBtnDisabled,
              pressed && styles.sendBtnPressed,
            ]}
          >
            {sendMut.isPending ? (
              <ActivityIndicator size="small" color={colors.surface} />
            ) : (
              <Ionicons name="arrow-up" size={18} color={colors.surface} />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <PastChatsSheet
        open={pastChatsOpen}
        onClose={() => setPastChatsOpen(false)}
      />
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
    <Modal
      visible={open}
      animationType="fade"
      transparent
      onRequestClose={onClose}
    >
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

// ─── Message bubble + empty ────────────────────────────────────────────────

function messageKey(m: ChatMessageRow | PendingMessage, idx: number): string {
  if ('clientId' in m) return m.clientId
  return m.id || `idx-${idx}`
}

function isPending(m: ChatMessageRow | PendingMessage): m is PendingMessage {
  return 'clientId' in m
}

function EmptyState(): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Ionicons name="chatbubble-outline" size={40} color={colors.text4} />
      <Text style={styles.emptyTitle}>Ask anything</Text>
      <Text style={styles.emptyHint}>
        Cyggie has access to your portfolio companies, recent meetings, and
        contacts. Try &ldquo;what should I follow up on this week?&rdquo;
      </Text>
    </View>
  )
}

function MessageBubble({
  message,
}: {
  message: ChatMessageRow | PendingMessage
}): React.JSX.Element {
  const isUser = message.role === 'user'
  const pending = isPending(message) ? message.pending === true : false
  return (
    <View
      style={[
        styles.bubbleRow,
        isUser ? styles.bubbleRowRight : styles.bubbleRowLeft,
      ]}
    >
      <View style={[styles.bubble, isUser ? styles.user : styles.assistant]}>
        {pending && !message.content ? (
          <View style={styles.thinkingRow}>
            <ActivityIndicator size="small" color={colors.text3} />
            <Text style={styles.thinkingText}>Thinking…</Text>
          </View>
        ) : isUser ? (
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>
            {message.content}
          </Text>
        ) : (
          <Markdown style={chatMarkdownStyles}>{message.content}</Markdown>
        )}
      </View>
    </View>
  )
}

// ─── Styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  center: { padding: spacing.lg, alignItems: 'center', justifyContent: 'center' },
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

  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },

  scroll: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },

  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl * 2,
  },
  emptyTitle: { color: colors.text, fontSize: type.h2, fontWeight: '600' },
  emptyHint: {
    color: colors.text3,
    fontSize: type.body,
    textAlign: 'center',
    lineHeight: 20,
  },

  bubbleRow: { flexDirection: 'row' },
  bubbleRowLeft: { justifyContent: 'flex-start' },
  bubbleRowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '88%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.xl,
  },
  user: { backgroundColor: colors.crimson, borderBottomRightRadius: radii.sm },
  assistant: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderBottomLeftRadius: radii.sm,
  },
  bubbleText: { color: colors.text, fontSize: type.body + 1, lineHeight: 22 },
  bubbleTextUser: { color: colors.surface },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thinkingText: { color: colors.text3, fontSize: type.body, fontStyle: 'italic' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.md : spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 120,
    backgroundColor: colors.surface3,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: type.body + 1,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: radii.pill,
    backgroundColor: colors.crimson,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.text4 },
  sendBtnPressed: { opacity: 0.7 },
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

const chatMarkdownStyles = StyleSheet.create({
  body: { color: colors.text, fontSize: type.body + 1, lineHeight: 22 },
  heading1: { color: colors.text, fontSize: type.h2, fontWeight: '700', marginTop: 8 },
  heading2: { color: colors.text, fontSize: type.h2 - 2, fontWeight: '700', marginTop: 8 },
  heading3: { color: colors.text, fontSize: type.body + 2, fontWeight: '600', marginTop: 6 },
  paragraph: { marginTop: 4, marginBottom: 4 },
  bullet_list: { marginTop: 2, marginBottom: 2 },
  ordered_list: { marginTop: 2, marginBottom: 2 },
  list_item: { marginVertical: 2 },
  code_inline: {
    backgroundColor: colors.surface3,
    color: colors.text,
    paddingHorizontal: 4,
    borderRadius: 4,
    fontSize: type.body,
  },
  fence: {
    backgroundColor: colors.surface3,
    color: colors.text,
    padding: spacing.sm,
    borderRadius: radii.sm,
    fontSize: type.bodyTight,
  },
  link: { color: colors.crimson },
  strong: { fontWeight: '700', color: colors.text },
})
