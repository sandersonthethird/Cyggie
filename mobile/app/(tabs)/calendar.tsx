import { useQuery } from '@tanstack/react-query'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { api } from '../../lib/api/client'
import { useAuthStore } from '../../lib/auth/store'

// Placeholder Calendar tab. M1a only verifies the signed-in state; the real
// calendar list (GET /calendar/events) lands in M1b. For now this fetches
// /firms/me as a smoke test that the JWT carries firm_id and the auth client
// works end-to-end.

interface FirmDetails {
  id: string
  name: string
  slug: string
  plan: string
}

export default function CalendarTab() {
  const signOut = useAuthStore((s) => s.signOut)
  const firmQuery = useQuery({
    queryKey: ['firms', 'me'],
    queryFn: () => api.get<FirmDetails>('/firms/me'),
    staleTime: 60_000,
  })

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <Text style={styles.label}>Workspace</Text>
        {firmQuery.isLoading && <ActivityIndicator color="#fafafa" />}
        {firmQuery.error && (
          <Text style={styles.error}>
            Could not load firm: {firmQuery.error.message}
          </Text>
        )}
        {firmQuery.data && (
          <>
            <Text style={styles.firmName}>{firmQuery.data.name}</Text>
            <Text style={styles.firmMeta}>
              {firmQuery.data.slug} · {firmQuery.data.plan}
            </Text>
          </>
        )}

        <View style={styles.spacer} />
        <Text style={styles.hint}>
          Real calendar wiring lands in M1b. This screen just proves the
          signed-in API client works.
        </Text>

        <View style={styles.spacer} />
        <Pressable onPress={signOut} style={styles.signOutButton}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0a' },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  label: {
    color: '#666',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
  },
  firmName: {
    color: '#fafafa',
    fontSize: 28,
    fontWeight: '700',
  },
  firmMeta: {
    color: '#888',
    fontSize: 14,
    marginTop: 4,
  },
  spacer: { height: 24 },
  hint: {
    color: '#666',
    fontSize: 13,
    lineHeight: 18,
  },
  error: {
    color: '#f87171',
    fontSize: 14,
  },
  signOutButton: {
    backgroundColor: '#1a1a1a',
    borderColor: '#2a2a2a',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  signOutText: { color: '#fafafa', fontSize: 14, fontWeight: '500' },
})
