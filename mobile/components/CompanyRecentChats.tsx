import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'
import { useQuery } from '@tanstack/react-query'

import { fetchChatSessions } from '../lib/api/chat'
import { ChatSessionRow } from './ChatSessionRow'
import { colors, spacing, type } from '../theme'

// Collapsible "Recent chats" section shown at the top of a company's chat
// screen. Lists the company's prior chats (active + archived) so the user
// can resume one instead of starting over. Rendered only on the default
// company-chat entry — hidden in resume mode (see the screen wrapper).
//
//   ┌─ Recent chats · 3 ───────────────────────────  ▼ ┐  ← header toggles
//   │  💬 Pricing questions      Company · 4 msg · 2d │  │
//   │  💬 Intro call follow-up   Company · 9 msg · 1w │  │  ← each row resumes
//   └────────────────────────────────────────────────┘  │     that session by id
//
// Collapses automatically when the user sends a message (parent flips
// `collapsed`), so it stops taking space mid-conversation.

const MAX_ROWS = 5

export function CompanyRecentChats({
  contextId,
  currentSessionId,
  collapsed,
  onToggle,
}: {
  contextId: string
  /** The session currently open on screen — excluded from the list so the
   *  active chat doesn't list itself. Undefined until it resolves. */
  currentSessionId?: string
  collapsed: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['chat', 'sessions-list', { contextId, includeArchived: true }],
    queryFn: ({ signal }) =>
      fetchChatSessions(
        { contextKind: 'company', contextId, includeArchived: true, limit: MAX_ROWS + 1 },
        { signal },
      ),
    staleTime: 30_000,
  })

  // Fail-silent but visible: this section is an enhancement and must never
  // block the chat surface, but a load failure should still be debuggable.
  useEffect(() => {
    if (query.error) {
      // eslint-disable-next-line no-console
      console.warn('[chat] recent-chats load failed:', query.error)
    }
  }, [query.error])

  const sessions = (query.data?.sessions ?? [])
    .filter((s) => s.id !== currentSessionId)
    .slice(0, MAX_ROWS)

  // Nothing to resume (loading, empty, or error) → render nothing at all so
  // we never show an empty header.
  if (sessions.length === 0) return null

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? 'Show recent chats' : 'Hide recent chats'}
      >
        <Ionicons name="time-outline" size={16} color={colors.text3} />
        <Text style={styles.headerText}>Recent chats · {sessions.length}</Text>
        <Ionicons
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={16}
          color={colors.text3}
        />
      </Pressable>

      {!collapsed && (
        <View style={styles.list}>
          {sessions.map((s) => (
            <ChatSessionRow
              key={s.id}
              session={s}
              onPress={() =>
                router.push({
                  pathname: '/chat/[contextKind]/[contextId]',
                  params: {
                    contextKind: 'company',
                    contextId,
                    sessionId: s.id,
                    label: s.title ?? s.contextLabel ?? 'Chat',
                  },
                })
              }
            />
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  headerText: {
    flex: 1,
    color: colors.text3,
    fontSize: type.meta,
    fontWeight: '600',
  },
  pressed: { opacity: 0.6 },
  list: {
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
})
