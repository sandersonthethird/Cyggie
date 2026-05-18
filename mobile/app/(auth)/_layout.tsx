import { Stack } from 'expo-router'

// Auth route group. Currently just the sign-in flow; onboarding screens
// (create-workspace, join-firm) land in M1a Step 7.
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#0a0a0a' },
      }}
    />
  )
}
