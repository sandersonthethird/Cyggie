import { Tabs } from 'expo-router'

// Signed-in tab navigator. M1a only ships Calendar; the other six (Meetings,
// Companies, Contacts, Notes, Chat, Search FAB) land across M2–M5.
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#fafafa',
        tabBarInactiveTintColor: '#666',
        tabBarStyle: {
          backgroundColor: '#0a0a0a',
          borderTopColor: '#1a1a1a',
        },
      }}
    >
      <Tabs.Screen name="calendar" options={{ title: 'Calendar' }} />
    </Tabs>
  )
}
