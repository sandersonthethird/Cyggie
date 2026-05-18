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
        // User backed out — silent.
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
      // Route by action hint. The actual create-workspace / join-firm
      // screens land in Step 7; for now we just redirect to / which the
      // dispatcher will route correctly.
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
            <ActivityIndicator color="#0a0a0a" />
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
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: '#fafafa',
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: -1,
  },
  subtitle: {
    color: '#888',
    fontSize: 16,
    marginTop: 8,
    textAlign: 'center',
  },
  spacer: { height: 60 },
  button: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: '#0a0a0a',
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: '#f87171',
    fontSize: 14,
    marginTop: 16,
    textAlign: 'center',
  },
})
