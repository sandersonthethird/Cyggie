import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import Constants from 'expo-constants'
import { useAuthStore } from '../lib/auth/store'
import { useCalendarStore } from '../lib/calendar/store'
import { colors, radii, spacing, type } from '../theme'

// M6-light: account + diagnostics in one place. Today's reachability is via
// the Calendar avatar tap; in the future a gear icon may live in other tab
// headers. Keep this screen route-shaped (not modal) so deep links work.

export default function SettingsScreen() {
  const userId = useAuthStore((s) => s.userId)
  const signOut = useAuthStore((s) => s.signOut)
  const dismissedCount = useCalendarStore((s) => s.dismissedIds.size)
  const undismissAll = useCalendarStore((s) => s.undismissAll)

  const appVersion = Constants.expoConfig?.version ?? 'unknown'
  const buildNumber = Constants.expoConfig?.ios?.buildNumber ?? '—'
  const gatewayUrl =
    (Constants.expoConfig?.extra?.['gatewayUrl'] as string | undefined) ?? 'unknown'
  const runtimeChannel = Constants.expoConfig?.updates?.requestHeaders?.['expo-channel-name'] ?? '—'

  const onSignOut = () => {
    Alert.alert('Sign out?', 'You will be returned to the welcome screen.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: () => {
          // signOut wipes auth state; the route guard in app/index.tsx
          // re-renders and redirects to /(auth)/sign-in. We just need to
          // pop back to "/" so the guard runs.
          void signOut()
          router.replace('/')
        },
      },
    ])
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.safeArea}>
        <View style={styles.topbar}>
          <Pressable
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(tabs)/calendar')
            }
            hitSlop={8}
            style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Ionicons name="chevron-back" size={22} color={colors.text} />
          </Pressable>
          <Text style={styles.topbarTitle}>Settings</Text>
          <View style={styles.backBtn} />
        </View>
      </SafeAreaView>
      <SafeAreaView edges={['bottom']} style={styles.bodyArea}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Section title="Account">
            <Row label="Signed in as" value={truncateUserId(userId)} />
            <RowAction
              icon="log-out-outline"
              label="Sign out"
              onPress={onSignOut}
              destructive
            />
          </Section>

          <Section title="App">
            <Row label="Version" value={`${appVersion} (${buildNumber})`} />
            <Row label="Channel" value={runtimeChannel} />
          </Section>

          <Section title="Server">
            <Row label="Gateway" value={gatewayUrl} mono />
          </Section>

          {dismissedCount > 0 && (
            <Section title="Calendar">
              <RowAction
                icon="eye-outline"
                label={`Restore ${dismissedCount} hidden event${dismissedCount === 1 ? '' : 's'}`}
                onPress={() => {
                  Alert.alert(
                    `Restore ${dismissedCount} hidden event${dismissedCount === 1 ? '' : 's'}?`,
                    undefined,
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Restore', onPress: () => undismissAll() },
                    ],
                  )
                }}
              />
            </Section>
          )}

          <Text style={styles.footer}>Cyggie · M6-light preview</Text>
        </ScrollView>
      </SafeAreaView>
    </View>
  )
}

function truncateUserId(userId: string | null): string {
  if (!userId) return '—'
  if (userId.length <= 12) return userId
  return `${userId.slice(0, 6)}…${userId.slice(-4)}`
}

interface SectionProps {
  title: string
  children: React.ReactNode
}

function Section({ title, children }: SectionProps): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  )
}

interface RowProps {
  label: string
  value: string
  mono?: boolean
}

function Row({ label, value, mono }: RowProps): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowValueMono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )
}

interface RowActionProps {
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  destructive?: boolean
}

function RowAction({ icon, label, onPress, destructive }: RowActionProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowActionInner}>
        <Ionicons
          name={icon}
          size={18}
          color={destructive ? colors.crimson : colors.text2}
        />
        <Text style={[styles.rowActionLabel, destructive && styles.destructive]}>{label}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.text4} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  safeArea: { backgroundColor: colors.surface },
  bodyArea: { flex: 1, backgroundColor: colors.bg },

  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topbarTitle: {
    flex: 1,
    color: colors.text,
    fontSize: type.h2,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: spacing.sm,
  },

  scroll: { padding: spacing.lg, gap: spacing.lg },

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

  footer: {
    color: colors.text4,
    fontSize: type.meta,
    textAlign: 'center',
    paddingTop: spacing.xl,
  },
})
