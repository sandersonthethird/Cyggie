import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { ApiError } from '../lib/api/client'
import { useAuthStore } from '../lib/auth/store'
import { reauthorizeGoogle } from '../lib/auth/oauth'
import { colors, radii, spacing, type } from '../theme'

// Gateway codes that mean "Google access (not the Cyggie session) needs
// re-consent." When the calendar endpoint surfaces any of these, we offer a
// real "Reconnect Google" button instead of the dead-end "Try again" — see
// api-gateway/src/routes/calendar.ts and mobile/lib/api/client.ts.
const REAUTH_CODES = new Set([
  'REAUTH_REQUIRED',
  'NO_GOOGLE_TOKENS',
  'NO_ACCESS_TOKEN',
  'GOOGLE_AUTH_FAILED',
])

export function needsGoogleReauth(error: unknown): boolean {
  return error instanceof ApiError && REAUTH_CODES.has(error.code)
}

// Reconnect-Google UI shown when the calendar endpoint reports an expired or
// revoked Google access. Replaces the dead-end "Try again" button in the
// `REAUTH_REQUIRED` branch.
//
//                   tap
//                    │
//                    ▼
//          reauthorizeGoogle({ authToken })
//             ├── cancel → no-op (stay on screen)
//             ├── error  → inline message, button re-enabled
//             └── success
//                  ├── userId mismatch → refuse signIn(), show "wrong account"
//                  └── userId match    → signIn() → onComplete() (parent refetches)
export function CalendarReauthState({ onComplete }: { onComplete: () => void }) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const currentUserId = useAuthStore((s) => s.userId)
  const currentAccessToken = useAuthStore((s) => s.accessToken)
  const signIn = useAuthStore((s) => s.signIn)

  async function onPress() {
    setMessage(null)
    setPending(true)
    try {
      const result = await reauthorizeGoogle({
        authToken: currentAccessToken ?? undefined,
      })
      if (result.kind === 'cancel') return
      if (result.kind === 'error') {
        setMessage(`${result.code}: ${result.message}`)
        return
      }
      // Defend against a user re-consenting with a different Google account.
      // The gateway sends login_hint to steer them to the right one, but they
      // can still override. Silently swapping userId would log them in as
      // someone else.
      if (currentUserId && result.userId !== currentUserId) {
        setMessage('Please reconnect with your original Google account.')
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
        // Mirror sign-in.tsx's defensive catch (M1b incident — without this
        // the user lands on an unchanged error screen with no feedback).
        const msg = err instanceof Error ? err.message : String(err)
        setMessage(`Sign-in failed after OAuth: ${msg}`)
        return
      }
      onComplete()
    } finally {
      setPending(false)
    }
  }

  return (
    <View style={styles.center} testID="reauth-state">
      <Text style={styles.title}>Calendar failed to load</Text>
      <Text style={styles.subtitle}>
        Your Google access has expired. Reconnect to keep seeing your calendar.
      </Text>
      <Pressable
        onPress={onPress}
        disabled={pending}
        style={({ pressed }) => [
          styles.button,
          (pressed || pending) && styles.pressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Reconnect Google"
        testID="reauth-button"
      >
        {pending ? (
          <ActivityIndicator color={colors.text} testID="reauth-spinner" />
        ) : (
          <Text style={styles.buttonText}>Reconnect Google</Text>
        )}
      </Pressable>
      {message && (
        <Text style={styles.message} accessibilityLiveRegion="polite" testID="reauth-message">
          {message}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  title: {
    color: colors.crimson,
    fontSize: type.body + 2,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  button: {
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 10,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.md,
    minWidth: 160,
    alignItems: 'center',
  },
  buttonText: { color: colors.text, fontSize: type.bodyTight, fontWeight: '500' },
  pressed: { opacity: 0.6 },
  message: {
    color: colors.text3,
    fontSize: type.bodyTight,
    textAlign: 'center',
    marginTop: spacing.md,
  },
})
