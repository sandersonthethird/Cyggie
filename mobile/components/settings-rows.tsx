// =============================================================================
// settings-rows.tsx — shared visual atoms for settings-style screens.
//
// Extracted from app/settings.tsx so the Settings screen and the dev-tools
// DLQ viewer (app/dev-tools/outbox-dlq.tsx) render identical cards/rows from a
// single source of truth. Screen-specific atoms (e.g. RowStepper) stay in the
// screen that uses them.
// =============================================================================

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radii, spacing, type } from '../theme'

export interface SectionProps {
  title: string
  children: React.ReactNode
}

export function Section({ title, children }: SectionProps): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  )
}

export interface RowProps {
  label: string
  value: string
  mono?: boolean
}

export function Row({ label, value, mono }: RowProps): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowValueMono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

export interface RowActionProps {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  destructive?: boolean
}

export function RowAction({
  icon,
  label,
  onPress,
  destructive,
}: RowActionProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowActionInner}>
        <Ionicons name={icon} size={18} color={destructive ? colors.crimson : colors.text2} />
        <Text style={[styles.rowActionLabel, destructive && styles.destructive]}>{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text4} />
    </Pressable>
  )
}

export const settingsRowStyles = StyleSheet.create({
  section: { gap: spacing.sm },
  sectionTitle: {
    fontSize: type.label,
    color: colors.text3,
    letterSpacing: 0.6,
    paddingHorizontal: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  rowLabel: { color: colors.text2, fontSize: type.body },
  rowValue: { color: colors.text, fontSize: type.body, flex: 1, textAlign: 'right' },
  rowValueMono: { fontSize: type.bodyTight, fontFamily: 'Menlo' },
  rowActionInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  rowActionLabel: { color: colors.text, fontSize: type.body },
  destructive: { color: colors.crimson, fontWeight: '600' },
  pressed: { backgroundColor: colors.surface3 },
})

const styles = settingsRowStyles
