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
import { pollForRecoveredSession, startSignIn, type SignInResult } from '../../lib/auth/oauth'
import { getOrCreateDeviceId } from '../../lib/auth/device'
import { useAuthStore } from '../../lib/auth/store'
import { colors, radii, spacing, type } from '../../theme'

export default function SignInScreen() {
  const [pending, setPending] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = useAuthStore((s) => s.signIn)

  async function onPress() {
    setError(null)
    setPending(true)
    try {
      let result: SignInResult = await startSignIn()
      // ASWebAuthenticationSession occasionally returns cancel/dismiss after
      // the gateway already minted a session (see oauth.ts header). Give the
      // recovery endpoint ~15s to find a freshly-minted session for this
      // device before we surrender to the cancel.
      if (result.kind === 'cancel') {
        setRecovering(true)
        try {
          const deviceId = await getOrCreateDeviceId()
          result = await pollForRecoveredSession(deviceId)
        } finally {
          setRecovering(false)
        }
      }
      if (result.kind === 'cancel') {
        return
      }
      if (result.kind === 'error') {
        setError(`${result.code}: ${result.message}`)
        return
      }
      try {
        await signIn({
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          userId: result.userId,
          action: result.action,
        })
      } catch (err) {
        // Without this catch the user lands back at sign-in with no
        // feedback — the most painful failure mode we hit during M1b.
        const msg = err instanceof Error ? err.message : String(err)
        setError(`Sign-in failed after OAuth: ${msg}`)
        return
      }
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

        {recovering && (
          <Text style={styles.recovering} accessibilityLiveRegion="polite">
            Finishing sign-in…
          </Text>
        )}

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
  recovering: {
    color: colors.text3,
    fontSize: type.bodyTight,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
