import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useFocusEffect } from '@react-navigation/native'
import Constants from 'expo-constants'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../lib/auth/store'
import { useCalendarStore } from '../lib/calendar/store'
import { fetchMe } from '../lib/api/auth'
import {
  fetchPreferences,
  setPreference,
  clampEmailThreads,
  EMAIL_THREADS_PREF_KEY,
  EMAIL_THREADS_DEFAULT,
} from '../lib/api/preferences'
import { Section, Row, RowAction, settingsRowStyles } from '../components/settings-rows'
import { dlqCount } from '../lib/sync/outbox'
import { colors, radii, spacing, type } from '../theme'

// M6-light: account + diagnostics in one place. Today's reachability is via
// the Calendar avatar tap; in the future a gear icon may live in other tab
// headers. Keep this screen route-shaped (not modal) so deep links work.

export default function SettingsScreen() {
  const userId = useAuthStore((s) => s.userId)
  const authStatus = useAuthStore((s) => s.status)
  const signOut = useAuthStore((s) => s.signOut)
  const dismissedCount = useCalendarStore((s) => s.dismissedIds.size)
  const undismissAll = useCalendarStore((s) => s.undismissAll)

  // DLQ count for the Developer row. Read once on mount + on focus (cheap, but
  // not on every render — decision 4B) so it reflects changes made on the
  // dead-letter screen after navigating back.
  const [dlqLen, setDlqLen] = useState(() => dlqCount())
  useFocusEffect(useCallback(() => setDlqLen(dlqCount()), []))

  const meQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: ({ signal }) => fetchMe({ signal }),
    enabled: authStatus === 'signed_in',
    staleTime: 5 * 60_000,
  })
  const email = meQuery.data?.email ?? null

  // Part E — per-company email-thread cap (synced preference, honored by chat).
  const queryClient = useQueryClient()
  const prefsQuery = useQuery({
    queryKey: ['user', 'preferences'],
    queryFn: ({ signal }) => fetchPreferences({ signal }),
    enabled: authStatus === 'signed_in',
    staleTime: 60_000,
  })
  const emailThreads = clampEmailThreads(
    Number(prefsQuery.data?.[EMAIL_THREADS_PREF_KEY] ?? EMAIL_THREADS_DEFAULT),
  )
  const setEmailThreads = useMutation({
    mutationFn: (n: number) => setPreference(EMAIL_THREADS_PREF_KEY, String(clampEmailThreads(n))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user', 'preferences'] }),
  })

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
          // Must await signOut before navigating: the store flips to
          // signed_out only after clearAllAuthStorage resolves. If we
          // navigate first, the index dispatcher still sees status=
          // signed_in and routes back to /(tabs)/calendar — the bug
          // that left the sign-out button looking like a no-op.
          void (async () => {
            await signOut()
            router.replace('/(auth)/sign-in')
          })()
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
            style={({ pressed }) => [styles.backBtn, pressed && settingsRowStyles.pressed]}
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
            <Row label="Signed in as" value={accountValue(email, userId, meQuery.isLoading)} />
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

          <Section title="AI Chat">
            <RowStepper
              label="Emails per company"
              value={emailThreads}
              disabled={prefsQuery.isLoading || setEmailThreads.isPending}
              onDecrement={() => setEmailThreads.mutate(emailThreads - 1)}
              onIncrement={() => setEmailThreads.mutate(emailThreads + 1)}
            />
          </Section>

          <Section title="Server">
            <Row label="Gateway" value={gatewayUrl} mono />
          </Section>

          <Section title="Developer">
            <RowAction
              icon="bug-outline"
              label={`Outbox dead-letter queue (${dlqLen})`}
              onPress={() => router.push('/dev-tools/outbox-dlq')}
            />
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

function accountValue(email: string | null, userId: string | null, isLoading: boolean): string {
  if (email) return email
  if (isLoading) return '…'
  return truncateUserId(userId)
}

interface RowStepperProps {
  label: string
  value: number
  disabled?: boolean
  onDecrement: () => void
  onIncrement: () => void
}

function RowStepper({
  label,
  value,
  disabled,
  onDecrement,
  onIncrement,
}: RowStepperProps): React.JSX.Element {
  return (
    <View style={settingsRowStyles.row}>
      <Text style={settingsRowStyles.rowLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label}`}
          disabled={disabled}
          onPress={onDecrement}
          hitSlop={8}
          style={({ pressed }) => [styles.stepperBtn, pressed && settingsRowStyles.pressed, disabled && styles.stepperDisabled]}
        >
          <Ionicons name="remove" size={18} color={colors.text} />
        </Pressable>
        <Text style={styles.stepperValue}>{value}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label}`}
          disabled={disabled}
          onPress={onIncrement}
          hitSlop={8}
          style={({ pressed }) => [styles.stepperBtn, pressed && settingsRowStyles.pressed, disabled && styles.stepperDisabled]}
        >
          <Ionicons name="add" size={18} color={colors.text} />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepperBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  stepperDisabled: { opacity: 0.4 },
  stepperValue: { color: colors.text, fontSize: type.body, fontWeight: '600', minWidth: 28, textAlign: 'center' },
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

  footer: {
    color: colors.text4,
    fontSize: type.meta,
    textAlign: 'center',
    paddingTop: spacing.xl,
  },
})
