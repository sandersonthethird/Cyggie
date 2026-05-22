import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radii, spacing, type } from '../theme'

// =============================================================================
// ErrorBanner — inline error surface for the Calendar tab (and any future
// surface that needs it). Parent owns the message state + auto-dismiss
// timer; component is purely presentational.
//
// Renders null when `message` is null so the parent can keep it mounted
// without paying layout cost when there's nothing to show.
// =============================================================================

interface Props {
  message: string | null
  onDismiss?: () => void
}

export function ErrorBanner({ message, onDismiss }: Props) {
  if (!message) return null
  return (
    <View style={styles.wrap}>
      <Ionicons name="alert-circle" size={16} color={colors.crimson} />
      <Text style={styles.text} numberOfLines={3}>
        {message}
      </Text>
      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          hitSlop={10}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Dismiss error"
        >
          <Ionicons name="close" size={16} color={colors.text3} />
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.crimsonMuted,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.crimson,
  },
  text: {
    flex: 1,
    color: colors.text,
    fontSize: type.bodyTight,
    fontWeight: '500',
  },
  close: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
})
