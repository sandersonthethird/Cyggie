import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { Ionicons } from '@expo/vector-icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Markdown from 'react-native-markdown-display'

import {
  type ChatContextKind,
  type ChatMessage,
  type ChatStreamError,
  type SendSessionMessageResult,
  createOrGetChatSession,
  fetchChatSession,
  sendSessionMessageStream,
} from '../lib/api/chat'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// ChatComposer — shared composer used by both the global Chat tab
// (mobile/app/(tabs)/chat.tsx) and the per-entity chat stack screen
// (mobile/app/chat/[contextKind]/[contextId].tsx).
//
// Owns:
//   - Session find-or-create (TanStack useQuery, dedupes by context key)
//   - Detail fetch + message list render
//   - Optimistic pending-message queue (user + assistant placeholder)
//   - Send mutation + 409 conflict reconciliation
//   - Composer text input + send button
//   - KeyboardAvoidingView wrapping the scrollview
//
// Does NOT own:
//   - Outer screen chrome (topbar, back button, kebab actions, past-chats
//     sheet, rename modal). Each screen wraps <ChatComposer /> with its own.
//
// Session-data sharing: both the wrapper screen AND this composer can call
// useQuery(['chat', 'session-by-context', kind, id], ...) — TanStack
// dedupes by key, so the wrapper gets the same cached session for its
// header / actions sheet without coordination.
// =============================================================================

export interface ChatComposerProps {
  contextKind: ChatContextKind
  contextId: string
  contextLabel?: string | null
  /** Optional empty-state node rendered when the session has zero messages. */
  emptyState?: ReactNode
  /** Placeholder shown inside the text input. */
  placeholder?: string
}

interface PendingMessage {
  clientId: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

export function ChatComposer({
  contextKind,
  contextId,
  contextLabel,
  emptyState,
  placeholder,
}: ChatComposerProps): React.JSX.Element {
  const qc = useQueryClient()
  const scrollRef = useRef<ScrollView | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<PendingMessage[]>([])

  const sessionQuery = useQuery({
    queryKey: ['chat', 'session-by-context', contextKind, contextId],
    queryFn: () =>
      createOrGetChatSession({
        contextKind,
        contextId,
        ...(contextLabel != null ? { contextLabel } : {}),
      }),
    enabled: Boolean(contextKind && contextId),
    staleTime: 60_000,
  })

  const sessionId = sessionQuery.data?.id

  const detailQuery = useQuery({
    queryKey: ['chat', 'session-detail', sessionId],
    queryFn: ({ signal }) => fetchChatSession(sessionId!, { signal }),
    enabled: Boolean(sessionId),
    staleTime: 15_000,
  })

  // T18 streaming: assistant placeholder's clientId is captured per-send
  // so token deltas append to the right pending row (vs setPending replacing
  // a stale closure reference). Refs avoid re-rendering on every token.
  const assistantClientIdRef = useRef<string | null>(null)

  const sendMut = useMutation({
    mutationFn: async (content: string) => {
      if (!sessionId) throw new Error('Session not ready')
      const assistantClientId = `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      assistantClientIdRef.current = assistantClientId
      const userPending: PendingMessage = {
        clientId: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        content,
      }
      const assistantPending: PendingMessage = {
        clientId: assistantClientId,
        role: 'assistant',
        content: '',
        pending: true,
      }
      setPending((prev) => [...prev, userPending, assistantPending])
      setInput('')

      return new Promise<
        { ok: true; result: SendSessionMessageResult } | { ok: false; error: ChatStreamError }
      >(
        (resolve) => {
          sendSessionMessageStream(
            sessionId,
            { content },
            {
              onToken: (delta) => {
                // Append delta to the in-flight assistant pending row.
                // pending=true is FLIPPED to false on first token so the
                // "Thinking…" placeholder gives way to the streaming text.
                setPending((prev) =>
                  prev.map((m) =>
                    m.clientId === assistantClientId
                      ? { ...m, pending: false, content: m.content + delta }
                      : m,
                  ),
                )
              },
              onDone: (final) => {
                resolve({ ok: true, result: final })
              },
              onError: (error) => {
                resolve({ ok: false, error })
              },
            },
          ).catch(() => {
            // sendSessionMessageStream never rejects (errors go through
            // onError) but guard anyway so a future bug doesn't hang.
            resolve({
              ok: false,
              error: { code: 'network', message: 'Stream rejected unexpectedly' },
            })
          })
        },
      )
    },
    onSuccess: (outcome) => {
      assistantClientIdRef.current = null
      if (outcome.ok) {
        setPending([])
        if (sessionId) {
          qc.invalidateQueries({ queryKey: ['chat', 'session-detail', sessionId] })
        }
      } else {
        // Error path: replace pending assistant with an error stub, leave
        // user message visible so the user can retry by resending.
        const errMsg = errorMessageFor(outcome.error)
        setPending((prev) =>
          prev.map((m) =>
            m.role === 'assistant' && m.pending !== undefined
              ? { ...m, pending: false, content: errMsg }
              : m,
          ),
        )
      }
    },
    onError: () => {
      // mutationFn itself shouldn't throw (we resolve always), but if it
      // does, mark the assistant pending row as failed.
      assistantClientIdRef.current = null
      setPending((prev) =>
        prev.map((m) =>
          m.role === 'assistant' && m.pending
            ? { ...m, pending: false, content: '_(failed to send — tap to retry)_' }
            : m,
        ),
      )
    },
  })

  // Per-error user-facing copy. Keeps the UX strings out of the mutation
  // body so they can be localized later.
  function errorMessageFor(err: ChatStreamError): string {
    switch (err.code) {
      case 'http':
        if (err.status === 413) return '_(That message is too large. Try a shorter one.)_'
        if (err.status === 409) return '_(Conflict — another device is also chatting here. Refresh and retry.)_'
        if (err.status === 401) return '_(Sign in required.)_'
        return `_(Send failed (HTTP ${err.status}). Tap to retry.)_`
      case 'gateway_error':
        return `_(${err.message || 'Upstream error'} — tap to retry.)_`
      case 'network':
        return '_(Network error — tap to retry.)_'
      case 'parse':
        return '_(Response parsing failed — tap to retry.)_'
    }
  }

  const messages = useMemo<Array<ChatMessage | PendingMessage>>(() => {
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

  const effectivePlaceholder =
    placeholder ??
    (contextLabel
      ? `Ask about ${contextLabel}…`
      : contextKind === 'crm'
        ? 'Ask anything…'
        : `Ask about this ${contextKind}…`)

  return (
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
          (emptyState ?? <DefaultEmptyState contextKind={contextKind} contextLabel={contextLabel} />)
        ) : (
          messages.map((m, idx) => <MessageBubble key={messageKey(m, idx)} message={m} />)
        )}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={effectivePlaceholder}
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
  )
}

// ─── helpers + subcomponents ────────────────────────────────────────────────

function messageKey(m: ChatMessage | PendingMessage, idx: number): string {
  if ('clientId' in m) return m.clientId
  return m.id || `idx-${idx}`
}

function isPending(m: ChatMessage | PendingMessage): m is PendingMessage {
  return 'clientId' in m
}

function MessageBubble({
  message,
}: {
  message: ChatMessage | PendingMessage
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
          <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{message.content}</Text>
        ) : (
          <Markdown style={chatMarkdownStyles}>{message.content}</Markdown>
        )}
      </View>
    </View>
  )
}

function DefaultEmptyState({
  contextKind,
  contextLabel,
}: {
  contextKind: ChatContextKind
  contextLabel?: string | null
}): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Ionicons name="chatbubble-outline" size={40} color={colors.text4} />
      <Text style={styles.emptyTitle}>
        {contextKind === 'crm' ? 'Ask anything' : 'Start a conversation'}
      </Text>
      <Text style={styles.emptyHint}>
        {contextKind === 'crm'
          ? 'Cyggie has access to your portfolio companies, recent meetings, and contacts.'
          : `Ask anything about ${contextLabel ?? `this ${contextKind}`}. The assistant has the relevant context loaded.`}
      </Text>
    </View>
  )
}

// ─── styles ────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { padding: spacing.lg, alignItems: 'center', justifyContent: 'center' },
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
