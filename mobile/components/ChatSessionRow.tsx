import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

import type { ChatSessionListItem } from '../lib/api/chat'
import { colors, radii, spacing, type } from '../theme'

// Shared chat-session row — a tappable list item showing a chat's icon,
// title, and a "kind · N msg · 3d ago" meta line. Used by the global
// past-chats sheet (mobile/app/chat/index.tsx) and the per-company recent-
// chats section (mobile/components/CompanyRecentChats.tsx). Extracted so
// both surfaces stay visually identical and the relative-time / icon
// helpers live in one place.

export function ChatSessionRow({
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
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surface3 }]}
      accessibilityRole="button"
      accessibilityLabel={`Open chat: ${label}`}
    >
      <View style={styles.rowIconWrap}>
        <Ionicons name={kindIcon} size={18} color={colors.text3} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {labelForKind(session.contextKind)}
          {session.messageCount > 0 ? ` · ${session.messageCount} msg` : ''}
          {when ? ` · ${when}` : ''}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.text4} />
    </Pressable>
  )
}

export function iconForKind(kind: string): keyof typeof Ionicons.glyphMap {
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

export function labelForKind(kind: string): string {
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

export function formatRelativeTime(iso: string): string {
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

const styles = StyleSheet.create({
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
