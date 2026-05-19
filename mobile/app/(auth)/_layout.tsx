import { Stack } from 'expo-router'
import { colors } from '../../theme'

// Auth route group: sign-in, create-workspace, join-firm. Light theme
// matches the rest of the app per docs/DESIGN.md.
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.surface },
      }}
    />
  )
}
