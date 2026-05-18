import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { api, ApiError } from '../../lib/api/client'
import { useAuthStore } from '../../lib/auth/store'
import { setLastAction } from '../../lib/auth/storage'

// Flow B — invitee accepts an admin-issued invite token.
//
// Token sources, in priority order:
//   1. Route param ?token=... (set by the magic-link deep-link handler)
//   2. User-pasted in the text field (fallback for "I got it via email")

interface JoinResponse {
  access_token: string
  firm: { id: string; name: string; slug: string; plan: string }
}

export default function JoinFirmScreen() {
  const params = useLocalSearchParams<{ token?: string }>()
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const updateAccessToken = useAuthStore((s) => s.updateAccessToken)

  // Pre-fill from the route param if the user got here via a magic link.
  useEffect(() => {
    if (typeof params.token === 'string' && params.token.length > 0) {
      setToken(params.token)
    }
  }, [params.token])

  async function onSubmit() {
    setError(null)
    const trimmed = token.trim()
    if (trimmed.length < 20) {
      setError('Invite token looks invalid. Paste the full token from your invite.')
      return
    }
    setPending(true)
    try {
      const response = await api.post<JoinResponse>('/auth/firms/join', {
        token: trimmed,
      })
      // Gateway minted a fresh access token with firm_id; refresh token
      // stays untouched (no FaceID prompt).
      await updateAccessToken({ accessToken: response.access_token })
      await setLastAction('returning')
      router.replace('/')
    } catch (err) {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'INVITE_NOT_FOUND':
            setError('Invite token not found. It may have already been used.')
            break
          case 'INVITE_ALREADY_ACCEPTED':
            setError('This invite has already been accepted by someone else.')
            break
          case 'INVITE_REVOKED':
            setError('This invite was revoked by an admin. Ask for a fresh one.')
            break
          case 'INVITE_EXPIRED':
            setError('This invite has expired. Ask for a fresh one.')
            break
          case 'INVITE_EMAIL_MISMATCH':
            setError(
              'This invite was sent to a different email address. Sign in with the email that received the invite.',
            )
            break
          case 'ALREADY_IN_FIRM':
            setError('Your account already belongs to a firm.')
            break
          case 'FIRM_DELETED':
            setError('The firm that issued this invite has been deleted.')
            break
          default:
            setError(`${err.code}: ${err.message}`)
        }
      } else {
        setError(err instanceof Error ? err.message : 'Could not join firm')
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Join firm</Text>
          <Text style={styles.subtitle}>
            Paste the invite token from your email, or tap the magic link to fill it in automatically.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Invite token</Text>
            <TextInput
              value={token}
              onChangeText={setToken}
              placeholder="paste-token-here"
              placeholderTextColor="#555"
              style={[styles.input, styles.inputMono]}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              multiline
              numberOfLines={3}
              editable={!pending}
            />
          </View>

          <View style={styles.spacer} />

          <Pressable
            onPress={onSubmit}
            disabled={pending || !token.trim()}
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
              (pending || !token.trim()) && styles.buttonDisabled,
            ]}
          >
            {pending ? (
              <ActivityIndicator color="#0a0a0a" />
            ) : (
              <Text style={styles.buttonText}>Join firm</Text>
            )}
          </Pressable>

          {error && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}

          <Pressable
            onPress={() => router.replace('/(auth)/create-workspace')}
            disabled={pending}
            style={styles.altLink}
          >
            <Text style={styles.altLinkText}>
              No invite? Create a new workspace instead →
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  scroll: { padding: 24, paddingBottom: 60 },
  title: {
    color: '#fafafa',
    fontSize: 32,
    fontWeight: '700',
    marginTop: 32,
  },
  subtitle: {
    color: '#888',
    fontSize: 15,
    marginTop: 8,
    marginBottom: 28,
  },
  field: { marginBottom: 20 },
  label: {
    color: '#bbb',
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#1a1a1a',
    color: '#fafafa',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    minHeight: 100,
    textAlignVertical: 'top',
  },
  inputMono: {
    // Token strings are easier to scan in monospace.
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 14,
  },
  spacer: { height: 12 },
  button: {
    backgroundColor: '#fafafa',
    borderRadius: 12,
    paddingVertical: 16,
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
  altLink: {
    marginTop: 24,
    alignItems: 'center',
  },
  altLinkText: {
    color: '#888',
    fontSize: 14,
  },
})
