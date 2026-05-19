import { useMemo, useState } from 'react'
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
import { router } from 'expo-router'
import { api, ApiError } from '../../lib/api/client'
import { useAuthStore } from '../../lib/auth/store'

// Flow A — first user from a firm creates the workspace.
//
// Form fields: name (required), slug (required, auto-suggested), and an
// optional primary_email_domain (only relevant when the firm later wants to
// flip Flow C domain auto-join on; we collect it now so M6 doesn't need a
// migration prompt).

interface ClaimResponse {
  access_token: string
  firm: {
    id: string
    name: string
    slug: string
    primary_email_domain: string | null
    domain_auto_join: boolean
    plan: string
  }
}

export default function CreateWorkspaceScreen() {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [domain, setDomain] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const updateAccessToken = useAuthStore((s) => s.updateAccessToken)
  const setLastAction = useAuthStore((s) => s.setLastAction)

  // Auto-suggest a slug while the user types the name. Cleared as soon as
  // they edit the slug field manually so we don't fight them.
  const [slugEdited, setSlugEdited] = useState(false)
  const suggestedSlug = useMemo(() => slugify(name), [name])
  const slugValue = slugEdited ? slug : suggestedSlug

  async function onSubmit() {
    setError(null)
    if (!name.trim()) {
      setError('Workspace name is required')
      return
    }
    if (!slugValue || slugValue.length < 3) {
      setError('Slug must be at least 3 characters')
      return
    }
    setPending(true)
    try {
      // The user already has a JWT with firm_id=null; this endpoint mints a
      // fresh one with firm_id baked in. The refresh token is NOT rotated by
      // the gateway here — leave the Keychain-stored refresh untouched (no
      // unnecessary FaceID prompt).
      const response = await api.post<ClaimResponse>('/auth/firms/claim', {
        name: name.trim(),
        slug: slugValue,
        ...(domain.trim() ? { primary_email_domain: domain.trim().toLowerCase() } : {}),
      })
      await updateAccessToken({ accessToken: response.access_token })
      await setLastAction('returning')
      router.replace('/')
    } catch (err) {
      if (err instanceof ApiError) {
        switch (err.code) {
          case 'SLUG_TAKEN':
            setError('That slug is already taken. Try another.')
            break
          case 'ALREADY_IN_FIRM':
            setError('Your account already belongs to a firm. Sign out and try again.')
            break
          case 'BAD_REQUEST':
            setError(
              'Slug must be lowercase letters, numbers, and single hyphens (e.g. red-swan).',
            )
            break
          default:
            setError(`${err.code}: ${err.message}`)
        }
      } else {
        setError(err instanceof Error ? err.message : 'Could not create workspace')
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
          <Text style={styles.title}>Create workspace</Text>
          <Text style={styles.subtitle}>
            Set up your firm. You can invite partners after this.
          </Text>

          <View style={styles.field}>
            <Text style={styles.label}>Firm name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Red Swan Ventures"
              placeholderTextColor="#555"
              style={styles.input}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="next"
              editable={!pending}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Slug</Text>
            <TextInput
              value={slugValue}
              onChangeText={(v) => {
                setSlugEdited(true)
                setSlug(v.toLowerCase())
              }}
              placeholder="red-swan"
              placeholderTextColor="#555"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="next"
              editable={!pending}
            />
            <Text style={styles.hint}>
              Lowercase letters, numbers, and single hyphens.
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Primary email domain (optional)</Text>
            <TextInput
              value={domain}
              onChangeText={setDomain}
              placeholder="redswanventures.com"
              placeholderTextColor="#555"
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              keyboardType="url"
              returnKeyType="done"
              editable={!pending}
            />
            <Text style={styles.hint}>
              Lets your team auto-join later. You can change this any time.
            </Text>
          </View>

          <View style={styles.spacer} />

          <Pressable
            onPress={onSubmit}
            disabled={pending}
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
              pending && styles.buttonDisabled,
            ]}
          >
            {pending ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Create workspace</Text>
            )}
          </Pressable>

          {error && (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
}

import { colors as themeColors, radii as themeRadii } from '../../theme'

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: themeColors.surface },
  scroll: {
    padding: 24,
    paddingBottom: 60,
  },
  title: {
    color: themeColors.text,
    fontSize: 32,
    fontWeight: '700',
    marginTop: 32,
    letterSpacing: -0.6,
  },
  subtitle: {
    color: themeColors.text3,
    fontSize: 15,
    marginTop: 8,
    marginBottom: 28,
  },
  field: { marginBottom: 20 },
  label: {
    color: themeColors.text2,
    fontSize: 13,
    fontWeight: '500',
    marginBottom: 8,
  },
  input: {
    backgroundColor: themeColors.surface,
    color: themeColors.text,
    borderRadius: themeRadii.md + 2,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: themeColors.border,
  },
  hint: {
    color: themeColors.text3,
    fontSize: 12,
    marginTop: 6,
  },
  spacer: { height: 12 },
  button: {
    backgroundColor: themeColors.crimson,
    borderRadius: themeRadii.lg,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
    shadowColor: themeColors.crimson,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 6,
  },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: themeColors.surface,
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: themeColors.crimson,
    fontSize: 14,
    marginTop: 16,
    textAlign: 'center',
  },
})
