import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { KeyboardAvoidingScreen } from './KeyboardAvoidingScreen'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { RichMarkdown, chatMarkdownStyles } from '../lib/markdown'
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
import { useClearOnSessionSwap } from './useClearOnSessionSwap'
import { CitationChipRow } from './CitationChipRow'

// =============================================================================
// ChatComposer — shared composer used by both the global chat screen
// (mobile/app/chat/index.tsx) and the per-entity chat stack screen
// (mobile/app/chat/[contextKind]/[contextId].tsx).
//
// Owns:
//   - Session find-or-create (TanStack useQuery, dedupes by context key)
//   - Detail fetch + message list render
//   - Optimistic pending-message queue (user + assistant placeholder)
//   - Send mutation + 409 conflict reconciliation
//   - Composer text input + send button
//   - KeyboardAvoidingScreen wrapping the scrollview (offset=92 for the appbar)
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

/**
 * Imperative handle exposed to wrapper screens via `ref`. Used by the
 * "New Chat" affordance (useStartNewChat hook) to abort an in-flight
 * stream BEFORE archiving the current session — prevents a streaming
 * reply from silently landing on the now-archived session, and avoids
 * paying for an LLM call whose result will never be displayed.
 */
export interface ChatComposerHandle {
  abortInflight: () => void
}

interface PendingMessage {
  clientId: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(
  function ChatComposer(
    { contextKind, contextId, contextLabel, emptyState, placeholder },
    ref,
  ): React.JSX.Element {
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

  // New Chat abort plumbing: the wrapper screen calls abortInflight() via
  // ChatComposerHandle before archiving the current session, so any
  // in-flight LLM stream terminates cleanly (no token spend, no silent
  // "answer landed in the archived session" trap).
  const inflightAbortRef = useRef<AbortController | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      abortInflight: () => inflightAbortRef.current?.abort(),
    }),
    [],
  )

  // Clear optimistic state when the New Chat affordance swaps in a new
  // session. See useClearOnSessionSwap.ts for swap semantics.
  useClearOnSessionSwap(sessionId, () => {
    setPending([])
    setInput('')
    assistantClientIdRef.current = null
  })

  // ─── No-retry failure policy (interim of full idempotency-key design) ─────
  //
  // Every chat send may or may not have reached Anthropic by the time it
  // fails on the wire. Surfacing a retry button is dangerous: tapping it
  // re-runs the LLM call and double-charges the firm for the same logical
  // question. We don't yet have request-id-based dedup on the gateway, so
  // the mobile rule is:
  //
  //   1. On any failure outcome, refetch the session detail.
  //   2. If server now holds both our user message AND an assistant reply,
  //      silently restore from server (stream dropped after persistence —
  //      the most common double-charge trap).
  //   3. If server holds the user message but no assistant reply, surface
  //      a non-retryable "may have been billed" error.
  //   4. If server holds neither, surface a generic non-retryable error.
  //
  // No path offers automatic retry; the user explicitly starts a new
  // question if they want to try again. Removes the entire class of
  // "tap-to-retry → duplicate Anthropic charge" bugs.
  // ─────────────────────────────────────────────────────────────────────────

  type MutationOutcome =
    | { ok: true; result: SendSessionMessageResult }
    | { ok: false; error: ChatStreamError; preSendMessageCount: number }

  const sendMut = useMutation({
    mutationFn: async (content: string): Promise<MutationOutcome> => {
      if (!sessionId) throw new Error('Session not ready')
      // Server's truth at send-time. Prefer detail (it's the freshest count
      // because every successful append round-trips through it) and fall
      // back to the list-shape session for the very first send.
      const preSendMessageCount =
        detailQuery.data?.messages.length ?? sessionQuery.data?.messageCount ?? 0
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

      const ac = new AbortController()
      inflightAbortRef.current = ac

      return new Promise<MutationOutcome>((resolve) => {
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
              resolve({ ok: false, error, preSendMessageCount })
            },
          },
          ac.signal,
        )
          .catch(() => {
            // sendSessionMessageStream never rejects (errors go through
            // onError) but guard anyway so a future bug doesn't hang.
            resolve({
              ok: false,
              error: { code: 'network', message: 'Stream rejected unexpectedly' },
              preSendMessageCount,
            })
          })
          .finally(() => {
            // Drop the ref only if we still own it — another mutate() may
            // have replaced it concurrently (shouldn't happen with our
            // isPending disable but be defensive).
            if (inflightAbortRef.current === ac) inflightAbortRef.current = null
          })
      })
    },
    onSuccess: async (outcome) => {
      assistantClientIdRef.current = null
      if (outcome.ok) {
        setPending([])
        if (sessionId) {
          qc.invalidateQueries({ queryKey: ['chat', 'session-detail', sessionId] })
        }
        return
      }

      // Failure path — interrogate server truth, then either silently
      // recover or hard-fail without offering retry.
      // Surface the raw error to Metro so Sandy can see WHY (the
      // user-facing copy is intentionally generic — see failureCopy).
      // eslint-disable-next-line no-console
      console.warn('[chat] send failed:', outcome.error)
      if (!sessionId) {
        replacePendingWithError(failureCopy('unknown'))
        return
      }

      let fresh: Awaited<ReturnType<typeof fetchChatSession>>
      try {
        fresh = await qc.fetchQuery({
          queryKey: ['chat', 'session-detail', sessionId],
          queryFn: ({ signal }) => fetchChatSession(sessionId, { signal }),
        })
      } catch {
        // Refetch failed — can't tell what happened server-side. Treat as
        // worst case (may have been billed) so the user doesn't reflexively
        // resend.
        replacePendingWithError(failureCopy('unknown'))
        return
      }

      const newCount = fresh.messages.length
      const delta = newCount - outcome.preSendMessageCount

      if (delta >= 2) {
        // Both turns persisted server-side. The wire failure was
        // post-persistence (stream cut after Anthropic finished); the
        // server result is authoritative — drop pending, server data
        // already populated the cache via fetchQuery.
        setPending([])
        return
      }
      if (delta >= 1) {
        // User message persisted but no assistant follow-up. Anthropic
        // may have been billed for a generation that didn't complete
        // (or completed but failed to persist). Don't offer retry.
        setPending([])
        appendErrorBubble(failureCopy('partially-billed'))
        return
      }
      // Nothing persisted server-side — the request likely never reached
      // the LLM. Per the no-retry policy we still don't auto-retry; user
      // can start a new question.
      replacePendingWithError(failureCopy(failureReasonFromError(outcome.error)))
    },
    onError: () => {
      // mutationFn itself shouldn't throw (we resolve always), but if it
      // does, surface a non-retryable error.
      assistantClientIdRef.current = null
      replacePendingWithError(failureCopy('unknown'))
    },
  })

  // ─── Failure-UX helpers ───────────────────────────────────────────────────

  function replacePendingWithError(message: string): void {
    setPending((prev) => {
      const next = prev.map((m) =>
        m.role === 'assistant' && m.pending !== undefined
          ? { ...m, pending: false, content: message }
          : m,
      )
      const hasAssistantStub = next.some(
        (m) => m.role === 'assistant' && m.pending !== undefined,
      )
      if (hasAssistantStub) return next
      // No assistant pending row left (edge case) — append a fresh stub.
      return [
        ...next,
        {
          clientId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: message,
          pending: false,
        },
      ]
    })
  }

  function appendErrorBubble(message: string): void {
    setPending([
      {
        clientId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: message,
        pending: false,
      },
    ])
  }

  type FailureReason =
    | 'too-large'
    | 'unauthorized'
    | 'conflict'
    | 'network'
    | 'parse'
    | 'gateway'
    | 'partially-billed'
    | 'unknown'

  function failureReasonFromError(err: ChatStreamError): FailureReason {
    switch (err.code) {
      case 'http':
        if (err.status === 413) return 'too-large'
        if (err.status === 401) return 'unauthorized'
        if (err.status === 409) return 'conflict'
        return 'unknown'
      case 'network':
        return 'network'
      case 'parse':
        return 'parse'
      case 'gateway_error':
        return 'gateway'
    }
  }

  function failureCopy(reason: FailureReason): string {
    // Every string omits "tap to retry" — no path in this component
    // re-runs the LLM call. User must start a new question.
    switch (reason) {
      case 'too-large':
        return '_(That message is too large. Start a new question with a shorter version.)_'
      case 'unauthorized':
        return '_(Sign-in expired. Please sign in again.)_'
      case 'conflict':
        return '_(Another device is chatting in this session. Refresh to see the latest, then start a new question.)_'
      case 'partially-billed':
        return '_(The AI started responding but the reply didn\'t come through. To avoid double-charging, this attempt won\'t auto-retry — start a new question if you\'d like to try again.)_'
      case 'network':
        return '_(Connection dropped before we got a reply. Start a new question to try again.)_'
      case 'parse':
        return '_(Reply was malformed. Start a new question to try again.)_'
      case 'gateway':
        return '_(Upstream error. Start a new question to try again.)_'
      case 'unknown':
        return '_(Send failed. Start a new question to try again.)_'
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
    <KeyboardAvoidingScreen style={styles.flex} offset={92}>
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
    </KeyboardAvoidingScreen>
  )
})

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
  // Citations only exist on a persisted assistant ChatMessage (not pending).
  const citations = !isUser && !isPending(message) ? message.citations : null
  return (
    <View
      style={[
        styles.bubbleRow,
        isUser ? styles.bubbleRowRight : styles.bubbleRowLeft,
      ]}
    >
      <View style={[styles.bubbleCol, isUser ? styles.bubbleColRight : styles.bubbleColLeft]}>
        <View style={[styles.bubble, isUser ? styles.user : styles.assistant]}>
          {pending && !message.content ? (
            <View style={styles.thinkingRow}>
              <ActivityIndicator size="small" color={colors.text3} />
              <Text style={styles.thinkingText}>Thinking…</Text>
            </View>
          ) : isUser ? (
            <Text style={[styles.bubbleText, styles.bubbleTextUser]}>{message.content}</Text>
          ) : (
            <RichMarkdown style={chatMarkdownStyles}>{message.content}</RichMarkdown>
          )}
        </View>
        <CitationChipRow citations={citations} />
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
  bubbleCol: { maxWidth: '88%' },
  bubbleColLeft: { alignItems: 'flex-start' },
  bubbleColRight: { alignItems: 'flex-end' },
  bubble: {
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

