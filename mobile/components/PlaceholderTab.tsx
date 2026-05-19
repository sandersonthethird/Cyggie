import { StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors, radii, spacing, type } from '../theme'

// Generic "coming in MX" tab placeholder. Used by Companies (M2), Chat (M5),
// Notes (M5), and Contacts (M2) tabs so the navigator scaffold lands now
// and each milestone just fills in the body.

export interface PlaceholderTabProps {
  title: string
  // Ionicons name shown in the centered hero — matches the tab bar icon.
  iconName: keyof typeof Ionicons.glyphMap
  milestone: 'M2' | 'M3' | 'M5'
  /** One-sentence preview of what will live here. */
  description: string
}

export function PlaceholderTab({ title, iconName, milestone, description }: PlaceholderTabProps) {
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>

      <View style={styles.content}>
        <View style={styles.iconWrap}>
          <Ionicons name={iconName} size={40} color={colors.text4} />
        </View>
        <Text style={styles.badge}>Coming in {milestone}</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerTitle: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.6,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  badge: {
    fontSize: type.label,
    fontWeight: '700',
    color: colors.crimson,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
  title: {
    fontSize: type.h1,
    fontWeight: '700',
    color: colors.text,
    letterSpacing: -0.4,
    marginBottom: spacing.md,
  },
  description: {
    fontSize: type.body,
    color: colors.text3,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
})
