import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { router } from 'expo-router'

import type { Citation, CitationType } from '../lib/api/chat'
import { colors, radii, spacing, type } from '../theme'

// M5 — renders the sources an assistant answer drew on, as tappable chips under
// the message bubble. Mirrors the desktop CitationChip. The type→route map is
// kept identical to desktop (unit-tested both sides) so navigation is consistent.

const ICON: Record<CitationType, keyof typeof Ionicons.glyphMap> = {
  company: 'business-outline',
  contact: 'person-outline',
  meeting: 'calendar-outline',
  note: 'document-text-outline',
}

/** type → mobile route. Keep identical to desktop's citationTarget (tested). */
export function citationRoute(c: Pick<Citation, 'type' | 'id'>): string {
  switch (c.type) {
    case 'company':
      return `/companies/${c.id}`
    case 'contact':
      return `/contacts/${c.id}`
    case 'meeting':
      return `/meetings/${c.id}`
    case 'note':
      return `/notes/${c.id}`
  }
}

export function CitationChipRow({ citations }: { citations: Citation[] | null | undefined }): React.JSX.Element | null {
  if (!citations || citations.length === 0) return null
  return (
    <View style={styles.row} accessibilityLabel="Sources">
      {citations.map((c) => (
        <Pressable
          key={`${c.type}:${c.id}`}
          onPress={() => router.push(citationRoute(c))}
          accessibilityRole="button"
          accessibilityLabel={`Source: ${c.label}`}
          style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
        >
          <Ionicons name={ICON[c.type]} size={12} color={colors.crimson} />
          <Text style={styles.chipText} numberOfLines={1}>
            {c.label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.pill,
  },
  chipText: {
    color: colors.crimson,
    fontSize: type.meta + 1,
    fontWeight: '600',
    maxWidth: 180,
  },
  pressed: { opacity: 0.6 },
})
