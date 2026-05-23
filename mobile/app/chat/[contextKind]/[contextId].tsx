import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-native-markdown-display'

import {
  type ChatContextKind,
  type ChatMessage,
  createOrGetChatSession,
  fetchChatSession,
  sendSessionMessage,
} from '../../../lib/api/chat'
import { colors, radii, spacing, type } from '../../../theme'

// T17b Slice 1 — per-entity chat surface. Mounted from meeting / contact /
// company detail screens via `router.push('/chat/<kind>/<contextId>?label=<...>')`.
//
// Lifecycle:
//   1. Mount with (contextKind, contextId) from the route. Optional `label`
//      search param seeds `contextLabel` for fresh sessions.
//   2. Find-or-create the session via POST /chat/sessions. Idempotent —
//      cheap to call on every mount.
//   3. Fetch session detail (messages) and render.
//   4. User types + sends → optimistic-append the user turn, POST
//      /chat/sessions/:id/messages, append the assistant turn on success.

const KINDS: Record<string, ChatContextKind> = {
  meeting: 'meeting',
  company: 'company',
  contact: 'contact',
  crm: 'crm',
  'search-results': 'search-results',
}

interface PendingMessage {
  /** Client-side id so we can replace it once the server reply arrives. */
  clientId: string
  role: 'user' | 'assistant'
  content: string
  /** Set true while the gateway round-trip is in flight (for the
   * assistant placeholder that says "Thinking…"). */
  pending?: boolean
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    contextKind: string
    contextId: string
    label?: string
  }>()

  const contextKind = KINDS[params.contextKind ?? '']
  const contextId = params.contextId ?? ''
  const contextLabel = (Array.isArray(params.label) ? params.label[0] : params.label) ?? null

  const qc = useQueryClient()

  // Stage 1 — find-or-create the session.
  const sessionQuery = useQuery({
    queryKey: ['chat', 'session-by-context', contextKind, contextId],
    queryFn: () =>
      createOrGetChatSession({
        contextKind: contextKind as ChatContextKind,
        contextId,
        contextLabel: contextLabel ?? undefined,
      }),
    enabled: Boolean(contextKind && contextId),
    staleTime: 60_000,
  })

  const sessionId = sessionQuery.data?.id

  // Stage 2 — load the session's message history.
  const detailQuery = useQuery({
    queryKey: ['chat', 'session-detail', sessionId],
    queryFn: ({ signal }) => fetchChatSession(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    staleTime: 15_000,
  })

  // Optimistic queue — what we've sent locally that the server hasn't
  // echoed back yet. Replaced by the real `messages` on each successful
  // send response. Lives outside the query cache so a refetch can't
  // wipe out an in-flight user turn.
  const [pending, setPending] = useState<PendingMessage[]>([])

  const scrollRef = useRef<ScrollView | null>(null)
  const [input, setInput] = useState('')

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('Session not ready')
      return sendSessionMessage(sessionId, { content })
    },
    onMutate: (content) => {
      // Append optimistic user + assistant-placeholder rows so the UI
      // updates immediately. They're cleared in onSuccess/onError.
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
        // Drop the pending pair; server-authoritative messages will appear
        // when detailQuery refetches.
        setPending([])
        if (sessionId) {
          qc.invalidateQueries({ queryKey: ['chat', 'session-detail', sessionId] })
        }
      } else {
        // 409 — clear pending; show the server's authoritative state.
        // Slice 2 will surface a proper conflict modal; for now the
        // refetch is enough so the user at least sees what's there.
        setPending([])
        if (sessionId) {
          qc.setQueryData(['chat', 'session-detail', sessionId], result.conflict)
        }
      }
    },
    onError: () => {
      // Leave the user's pending message visible so they can retry by
      // resending; replace the assistant placeholder with an error stub.
      setPending((prev) =>
        prev.map((m) =>
          m.role === 'assistant' && m.pending
            ? { ...m, pending: false, content: '_(failed to send — tap to retry)_' }
            : m,
        ),
      )
    },
  })

  // Combined feed = server messages + any in-flight pending rows. Pending
  // is appended after server messages because that's the user's intent
  // order — they only ever added to the bottom.
  const messages = useMemo<Array<ChatMessage | PendingMessage>>(() => {
    const server = detailQuery.data?.messages ?? []
    return [...server, ...pending]
  }, [detailQuery.data?.messages, pending])

  // Scroll-to-bottom on new content.
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true })
  }, [messages.length])

  const session = sessionQuery.data
  const headerTitle = session?.title ?? session?.contextLabel ?? contextLabel ?? 'Chat'

  const onSend = (): void => {
    const trimmed = input.trim()
    if (!trimmed || sendMut.isPending || !sessionId) return
    sendMut.mutate(trimmed)
  }

  // ────────────────────────────────────────────────────────────────────────

  if (!contextKind || !contextId) {
    return (
      <View style={styles.root}>
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
    <View style={styles.root}>
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
          <View style={styles.backBtn} />
        </View>
      </SafeAreaView>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        style={styles.body}
      >
        <ScrollView
          ref={scrollRef}
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
            <View style={styles.empty}>
              <Ionicons name="chatbubble-ellipses-outline" size={36} color={colors.text4} />
              <Text style={styles.emptyTitle}>Start a conversation</Text>
              <Text style={styles.emptyBody}>
                Ask anything about{' '}
                {contextLabel ?? `this ${contextKind}`}. The assistant has the relevant context loaded.
              </Text>
            </View>
          ) : (
            messages.map((m, idx) => <MessageBubble key={messageKey(m, idx)} message={m} />)
          )}
        </ScrollView>

        <View style={styles.inputBar}>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={
              contextLabel ? `Ask about ${contextLabel}…` : `Ask about this ${contextKind}…`
            }
            placeholderTextColor={colors.text4}
            multiline
            style={styles.input}
            editable={!sendMut.isPending}
          />
          <Pressable
            onPress={onSend}
            disabled={!input.trim() || sendMut.isPending || !sessionId}
            style={({ pressed }) => [
              styles.sendBtn,
              (!input.trim() || sendMut.isPending || !sessionId) && styles.sendBtnDisabled,
              pressed && styles.pressed,
            ]}
            accessibilityLabel="Send message"
            accessibilityRole="button"
          >
            {sendMut.isPending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="arrow-up" size={20} color="#fff" />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

// ─── Message bubble ────────────────────────────────────────────────────────

function messageKey(m: ChatMessage | PendingMessage, idx: number): string {
  if ('clientId' in m) return m.clientId
  return m.id || `idx-${idx}`
}

function isPending(m: ChatMessage | PendingMessage): m is PendingMessage {
  return 'clientId' in m
}

function MessageBubble({ message }: { message: ChatMessage | PendingMessage }) {
  const isUser = message.role === 'user'
  const pending = isPending(message) ? message.pending === true : false

  return (
    <View
      style={[
        styles.bubbleWrap,
        isUser ? styles.bubbleWrapUser : styles.bubbleWrapAssistant,
      ]}
    >
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        {pending && !message.content ? (
          <View style={styles.thinkingRow}>
            <ActivityIndicator size="small" color={colors.text3} />
            <Text style={styles.thinkingText}>Thinking…</Text>
          </View>
        ) : isUser ? (
          <Text style={styles.bubbleUserText}>{message.content}</Text>
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
  body: { flex: 1 },
  scroll: { padding: spacing.md, gap: spacing.sm },
  center: { padding: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.text3, fontSize: type.body, textAlign: 'center' },
  empty: {
    padding: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.text, fontSize: type.h2, fontWeight: '600' },
  emptyBody: {
    color: colors.text3,
    fontSize: type.body,
    textAlign: 'center',
    maxWidth: 280,
  },
  bubbleWrap: { flexDirection: 'row' },
  bubbleWrapUser: { justifyContent: 'flex-end' },
  bubbleWrapAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '88%',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
  },
  bubbleUser: {
    backgroundColor: colors.crimson,
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  bubbleUserText: { color: '#fff', fontSize: type.body + 1, lineHeight: 22 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  thinkingText: { color: colors.text3, fontSize: type.body, fontStyle: 'italic' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: radii.lg,
    backgroundColor: colors.bg,
    color: colors.text,
    fontSize: type.body + 1,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.crimson,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.text4, opacity: 0.6 },
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
