import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Platform } from 'react-native'
import { colors } from '../../theme'

// Signed-in tab navigator — matches WIREFRAME 1's tab bar. Five tabs:
//   • Calendar  — today's agenda (M1b, the only fully-implemented tab)
//   • Companies — placeholder, lands in M2
//   • Chat      — placeholder, lands in M5
//   • Notes     — placeholder, lands in M5
//   • Contacts  — placeholder, lands in M2
//
// The 4 placeholders ship now so the navigator shape is final and each
// subsequent milestone just fills the body without re-juggling tab order.
// Recording is intentionally NOT a tab — it's an action (the Record FAB,
// floats above Calendar). Per wireframe annotation: "5 tabs, no Record tab".

type IoniconName = keyof typeof Ionicons.glyphMap

interface TabConfig {
  name: string
  title: string
  iconActive: IoniconName
  iconInactive: IoniconName
}

const TABS: TabConfig[] = [
  { name: 'calendar', title: 'Calendar', iconActive: 'calendar', iconInactive: 'calendar-outline' },
  { name: 'companies', title: 'Companies', iconActive: 'business', iconInactive: 'business-outline' },
  { name: 'chat', title: 'Chat', iconActive: 'chatbubble', iconInactive: 'chatbubble-outline' },
  { name: 'notes', title: 'Notes', iconActive: 'document-text', iconInactive: 'document-text-outline' },
  { name: 'contacts', title: 'Contacts', iconActive: 'people', iconInactive: 'people-outline' },
]

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.crimson,
        tabBarInactiveTintColor: colors.text4,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          // Extra height + smaller label so icons read like the wireframe.
          height: Platform.OS === 'ios' ? 88 : 64,
          paddingTop: 6,
        },
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '500',
          letterSpacing: 0.1,
        },
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            tabBarIcon: ({ focused, color, size }) => (
              <Ionicons
                name={focused ? t.iconActive : t.iconInactive}
                size={size}
                color={color}
              />
            ),
          }}
        />
      ))}
    </Tabs>
  )
}
