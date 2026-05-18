import { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useAuthStore } from '../lib/auth/store'

// Index route — pure dispatcher. Routes the user to:
//   • /(auth)/sign-in           when signed_out
//   • /(auth)/create-workspace  when signed_in AND lastAction=create_workspace
//   • /(auth)/join-firm         when signed_in AND lastAction=join_firm
//   • /(tabs)/calendar          when signed_in AND lastAction=returning
//
// The lastAction value comes from the gateway's cyggie:// callback redirect,
// stashed by the auth store during signIn(). It is mutated after onboarding
// completes (Step 7 routes set it to 'returning' before router.replace('/')).

export default function IndexScreen() {
  const status = useAuthStore((s) => s.status)
  const lastAction = useAuthStore((s) => s.lastAction)

  useEffect(() => {
    if (status === 'idle' || status === 'loading') return

    if (status === 'signed_out') {
      router.replace('/(auth)/sign-in')
      return
    }

    // signed_in. Branch by the onboarding action hint.
    switch (lastAction) {
      case 'create_workspace':
        router.replace('/(auth)/create-workspace')
        return
      case 'join_firm':
        router.replace('/(auth)/join-firm')
        return
      case 'returning':
      default:
        router.replace('/(tabs)/calendar')
        return
    }
  }, [status, lastAction])

  return (
    <View style={styles.root}>
      <ActivityIndicator color="#fafafa" size="large" />
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    alignItems: 'center',
    justifyContent: 'center',
  },
})
