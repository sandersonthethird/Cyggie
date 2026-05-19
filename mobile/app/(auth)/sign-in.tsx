import { useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { startSignIn } from '../../lib/auth/oauth'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

export default function SignInScreen() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = useAuthStore((s) => s.signIn)

  async function onPress() {
    setError(null)
    setPending(true)
    try {
      const result = await startSignIn()
      if (result.kind === 'cancel') {
        return
      }
      if (result.kind === 'error') {
        setError(`${result.code}: ${result.message}`)
        return
      }
      await signIn({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        userId: result.userId,
        action: result.action,
      })
      router.replace('/')
    } finally {
      setPending(false)
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <Text style={styles.title}>Cyggie</Text>
        <Text style={styles.subtitle}>The CRM that records itself.</Text>

        <View style={styles.spacer} />

        <Pressable
          onPress={onPress}
          disabled={pending}
          style={({ pressed }) => [
            styles.button,
            pressed && styles.buttonPressed,
            pending && styles.buttonDisabled,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
        >
          {pending ? (
            <ActivityIndicator color={colors.surface} />
          ) : (
            <Text style={styles.buttonText}>Continue with Google</Text>
          )}
        </Pressable>

        {error && (
          <Text style={styles.error} accessibilityLiveRegion="polite">
            {error}
          </Text>
        )}
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: colors.text,
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: -1.2,
  },
  subtitle: {
    color: colors.text3,
    fontSize: type.body + 2,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
  spacer: { height: 60 },
  button: {
    backgroundColor: colors.crimson,
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xxl,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    shadowColor: colors.crimson,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: colors.surface,
    fontSize: type.body + 2,
    fontWeight: '600',
  },
  error: {
    color: colors.crimson,
    fontSize: type.bodyTight,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
