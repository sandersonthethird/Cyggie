import { useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { AntDesign } from '@expo/vector-icons'
import { router } from 'expo-router'
import { reauthorizeGoogle, type SignInResult } from '../../lib/auth/oauth'
import { useAuthStore } from '../../lib/auth/store'
import { colors } from '../../theme'

export default function SignInScreen() {
  const [pending, setPending] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signIn = useAuthStore((s) => s.signIn)

  async function onPress() {
    setError(null)
    setPending(true)
    console.log('[auth] sign-in: onPress start')
    try {
      // reauthorizeGoogle wraps startSignIn + iOS dismiss-after-success
      // recovery polling. Fresh sign-in → no authToken; gateway returns
      // an authUrl without login_hint. The onRecovering callback flips the
      // "Finishing sign-in…" UI on once the recovery poll starts.
      let result: SignInResult
      try {
        result = await reauthorizeGoogle({
          onRecovering: () => setRecovering(true),
        })
      } finally {
        setRecovering(false)
      }
      console.log('[auth] sign-in: reauthorizeGoogle returned kind=' + result.kind)
      if (result.kind === 'cancel') {
        console.log('[auth] sign-in: returning at cancel (no recovery hit)')
        return
      }
      if (result.kind === 'error') {
        console.log('[auth] sign-in: error code=' + result.code + ' msg=' + result.message)
        setError(`${result.code}: ${result.message}`)
        return
      }
      try {
        console.log('[auth] sign-in: persisting tokens via store.signIn')
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
        console.log('[auth] sign-in: store.signIn threw: ' + msg)
        setError(`Sign-in failed after OAuth: ${msg}`)
        return
      }
      console.log('[auth] sign-in: router.replace(/)')
      router.replace('/')
    } finally {
      setPending(false)
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.content}>
        <View style={styles.spacerTop} />

        <View style={styles.hero}>
          <Text
            style={styles.wordmark}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            Cyggie<Text style={styles.wordmarkPeriod}>.</Text>
          </Text>
          <Text style={styles.tagline}>Stop updating your CRM.</Text>
        </View>

        <View style={styles.spacerBottom} />

        <View style={styles.actions}>
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
              <ActivityIndicator color={colors.textOnDark} />
            ) : (
              <>
                <AntDesign name="google" size={18} color={colors.textOnDark} style={styles.buttonIcon} />
                <Text style={styles.buttonText}>Continue with Google</Text>
              </>
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

          <Text style={styles.legal}>
            By continuing, you agree to our{' '}
            <Text style={styles.legalLink}>Terms</Text>
            {' & '}
            <Text style={styles.legalLink}>Privacy</Text>
            .
          </Text>
        </View>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.darkSurface },
  content: {
    flex: 1,
    paddingHorizontal: 28,
    paddingBottom: 32,
  },
  spacerTop: { flex: 1 },
  spacerBottom: { flex: 2 },
  hero: {
    alignItems: 'flex-start',
  },
  wordmark: {
    color: colors.textOnDark,
    fontSize: 68,
    fontWeight: '800',
    letterSpacing: -3,
    includeFontPadding: false,
  },
  wordmarkPeriod: {
    color: colors.rec,
  },
  tagline: {
    color: colors.textOnDark3,
    fontSize: 17,
    fontWeight: '500',
    marginTop: 16,
  },
  actions: {
    alignItems: 'stretch',
  },
  button: {
    backgroundColor: colors.crimson,
    borderRadius: 14,
    height: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.rec,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 8,
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonIcon: { marginRight: 10 },
  buttonText: {
    color: colors.textOnDark,
    fontSize: 15.5,
    fontWeight: '600',
  },
  recovering: {
    color: colors.textOnDark3,
    fontSize: 13.5,
    marginTop: 16,
    textAlign: 'center',
  },
  error: {
    color: colors.rec,
    fontSize: 13.5,
    marginTop: 16,
    textAlign: 'center',
  },
  legal: {
    color: colors.textOnDark4,
    fontSize: 11.5,
    lineHeight: 18,
    letterSpacing: 0.1,
    textAlign: 'center',
    marginTop: 18,
  },
  legalLink: {
    color: colors.textOnDark2,
    textDecorationLine: 'underline',
    textDecorationColor: colors.textOnDarkBorder,
  },
})
