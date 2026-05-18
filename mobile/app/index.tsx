import { StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

// Placeholder landing screen. Real sign-in / Calendar dispatch lands in
// Step 6 (mobile auth wiring). For now this just proves the Expo + router
// + provider stack boots cleanly.

export default function IndexScreen() {
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <Text style={styles.title}>Cyggie</Text>
        <Text style={styles.subtitle}>Mobile shell — auth wiring in M1a Step 6</Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    color: '#fafafa',
    fontSize: 36,
    fontWeight: '700',
    marginBottom: 12,
  },
  subtitle: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
  },
})
