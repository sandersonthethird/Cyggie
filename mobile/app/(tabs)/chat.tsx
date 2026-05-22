import { useCallback, useRef, useState } from 'react'
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
import { SafeAreaView } from 'react-native-safe-area-context'
import { ApiError } from '../../lib/api/client'
import { sendChatMessage } from '../../lib/api/chat'
import { colors, radii, spacing, type } from '../../theme'

// M5-thin Chat tab — stateless one-shot Q&A against the gateway.
//
// In-memory message list (lost on tab unmount). Sessions, persistence, sync,
// streaming, citations all deferred — see TODOS M5 follow-ups. The point of
// this slice is to land a working AI surface in mobile so the first build
// has something on the Chat tab to demo.

type Role = 'user' | 'assistant' | 'error'

interface ChatMessage {
  id: string
  role: Role
  text: string
}

export default function ChatTab(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<ScrollView | null>(null)

  const onSend = useCallback(async () => {
    const trimmed = input.trim()
    if (trimmed.length === 0 || sending) return

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', text: trimmed }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setSending(true)

    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))

    try {
      const { reply } = await sendChatMessage({ message: trimmed })
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', text: reply },
      ])
    } catch (err) {
      const text =
        err instanceof ApiError
          ? err.code === 'CHAT_UNAVAILABLE'
            ? 'Chat is not configured on the server yet.'
            : err.message
          : 'Something went wrong. Please try again.'
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'error', text },
      ])
    } finally {
      setSending(false)
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }))
    }
  }, [input, sending])

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.root}>
      <View style={styles.appbar}>
        <Text style={styles.title}>Ask Cyggie</Text>
        <Text style={styles.subtitle}>Stateless preview · sessions land next</Text>
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
          {messages.length === 0 && <EmptyState />}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {sending && (
            <View style={[styles.bubble, styles.assistant]}>
              <ActivityIndicator size="small" color={colors.text3} />
            </View>
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
            editable={!sending}
            returnKeyType="send"
            blurOnSubmit
            onSubmitEditing={onSend}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            onPress={onSend}
            disabled={sending || input.trim().length === 0}
            style={({ pressed }) => [
              styles.sendBtn,
              (sending || input.trim().length === 0) && styles.sendBtnDisabled,
              pressed && styles.sendBtnPressed,
            ]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.surface} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Ionicons name="chatbubble-outline" size={40} color={colors.text4} />
      <Text style={styles.emptyTitle}>Ask anything</Text>
      <Text style={styles.emptyHint}>
        Quick questions, drafting help, or sanity checks. Conversation
        history isn&apos;t saved yet — that lands in the next pass.
      </Text>
    </View>
  )
}

function MessageBubble({ message }: { message: ChatMessage }): React.JSX.Element {
  const isUser = message.role === 'user'
  const isError = message.role === 'error'
  return (
    <View
      style={[
        styles.bubbleRow,
        isUser ? styles.bubbleRowRight : styles.bubbleRowLeft,
      ]}
    >
      <View
        style={[
          styles.bubble,
          isUser && styles.user,
          !isUser && !isError && styles.assistant,
          isError && styles.error,
        ]}
      >
        <Text style={[styles.bubbleText, isUser && styles.bubbleTextUser]}>
          {message.text}
        </Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },

  appbar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { color: colors.text, fontSize: type.display, fontWeight: '700' },
  subtitle: { color: colors.text3, fontSize: type.meta, marginTop: 2 },

  scroll: {
    padding: spacing.lg,
    gap: spacing.sm,
    flexGrow: 1,
  },

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
    maxWidth: '85%',
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
  error: {
    backgroundColor: colors.crimsonMuted,
    borderColor: colors.crimson,
    borderWidth: 1,
  },
  bubbleText: { color: colors.text, fontSize: type.body, lineHeight: 20 },
  bubbleTextUser: { color: colors.surface },

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
    fontSize: type.body,
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
