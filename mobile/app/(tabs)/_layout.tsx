import { Tabs } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Platform } from 'react-native'
import { colors } from '../../theme'
import { RecordTabButton } from '../../components/RecordTabButton'

// Signed-in tab navigator. Five slots, with Record promoted to a raised center
// button (the app's highest-frequency action):
//   • Calendar  — today's agenda
//   • Companies — pipeline + portfolio
//   • Record    — raised center button → new meeting + record (see below)
//   • Notes     — notes surface
//   • Contacts  — people
//
// Record is NOT a real route — `new-meeting` is a placeholder whose custom
// tabBarButton (RecordTabButton) owns the press and pushes /record directly;
// the placeholder screen just redirects, so it never visibly mounts.
//
// Chat used to hold the center slot; it moved to a pushed root screen
// (app/chat/index) reached from the persistent ChatHeaderButton in every main
// screen's header.

type IoniconName = keyof typeof Ionicons.glyphMap

interface TabConfig {
  name: string
  title: string
  iconActive: IoniconName
  iconInactive: IoniconName
}

// Content tabs flanking the center Record button, in display order.
const LEADING_TABS: TabConfig[] = [
  { name: 'calendar', title: 'Calendar', iconActive: 'calendar', iconInactive: 'calendar-outline' },
  { name: 'companies', title: 'Companies', iconActive: 'business', iconInactive: 'business-outline' },
]
const TRAILING_TABS: TabConfig[] = [
  { name: 'notes', title: 'Notes', iconActive: 'document-text', iconInactive: 'document-text-outline' },
  { name: 'contacts', title: 'Contacts', iconActive: 'people', iconInactive: 'people-outline' },
]

function renderTab(t: TabConfig): React.JSX.Element {
  return (
    <Tabs.Screen
      key={t.name}
      name={t.name}
      options={{
        title: t.title,
        tabBarIcon: ({ focused, color, size }) => (
          <Ionicons name={focused ? t.iconActive : t.iconInactive} size={size} color={color} />
        ),
      }}
    />
  )
}

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
      {LEADING_TABS.map(renderTab)}

      {/* Center raised "new meeting" button. RecordTabButton fully owns the
          press → /record, so this route never visibly mounts. */}
      <Tabs.Screen
        name="new-meeting"
        options={{
          title: '',
          tabBarLabel: () => null,
          tabBarButton: (props) => <RecordTabButton {...props} />,
        }}
      />

      {TRAILING_TABS.map(renderTab)}
    </Tabs>
  )
}
