import { StyleSheet, Text, View } from 'react-native'
import { colors, spacing, type } from '../theme'

// Now-rail divider — wireframe element between the dimmed "Earlier today"
// section and the next/upcoming meetings. Marks "right now" so the eye
// jumps to what matters.

export interface NowRailProps {
  /** Localized time string, e.g. "9:14". */
  label: string
}

export function NowRail({ label }: NowRailProps) {
  return (
    <View style={styles.root}>
      <View style={styles.line} />
      <Text style={styles.label}>{label} · now</Text>
      <View style={styles.dot} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  line: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.crimson,
    opacity: 0.35,
  },
  label: {
    color: colors.crimson,
    fontSize: type.label,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 99,
    backgroundColor: colors.crimson,
  },
})
