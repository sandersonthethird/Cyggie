import { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { useAuthStore } from '../lib/auth/store'

// Index route — pure dispatcher. Routes the user to:
//   • /(auth)/sign-in    when signed_out
//   • /(tabs)/calendar   when signed_in AND action=returning
//   • /(auth)/create-workspace when signed_in AND action=create_workspace (Step 7)
//   • /(auth)/join-firm when signed_in AND action=join_firm (Step 7)
//
// Step 7 wires create-workspace and join-firm; for now the create_workspace
// and join_firm branches fall back to /(auth)/sign-in with an explanatory hint.

export default function IndexScreen() {
  const status = useAuthStore((s) => s.status)
  const lastAction = useAuthStore((s) => s.lastAction)

  useEffect(() => {
    if (status === 'idle' || status === 'loading') return

    if (status === 'signed_out') {
      router.replace('/(auth)/sign-in')
      return
    }

    // status === 'signed_in'. Branch by lastAction.
    if (lastAction === 'create_workspace') {
      // TODO Step 7: router.replace('/(auth)/create-workspace')
      router.replace('/(auth)/sign-in')
      return
    }
    if (lastAction === 'join_firm') {
      // TODO Step 7: router.replace('/(auth)/join-firm')
      router.replace('/(auth)/sign-in')
      return
    }
    // returning or unknown — go to home. M1b wires the real Calendar route.
    router.replace('/(auth)/sign-in')
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
