import React, { useRef } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import type { BottomTabBarButtonProps } from '@react-navigation/bottom-tabs'
import { useQueryClient } from '@tanstack/react-query'
import { colors, radii } from '../theme'
import { startImpromptuRecording } from '../lib/recording/start-impromptu'

// Raised center "new meeting" button that sits in the middle tab slot (where
// Chat used to be). One tap mints an impromptu meeting on-device, starts the
// mic, and opens the meeting view (the recording surface) — see
// lib/recording/start-impromptu.ts. It is NOT a navigable route — we render a
// custom tabBarButton and fully own the press, ignoring the nav props
// expo-router passes in, so the `new-meeting` placeholder route never mounts.
//
// Face = the app launcher mark (crimson swan-feathers) on a white circle, so
// the button reads as the same "Cyggie" icon the user taps to open the app.
//
//        ╭───────╮   ← white circle rises above the bar (lower 2/3 stays
//        │  swan │     inside the slot so the tap target is Android-safe)
//   ─────┴───────┴─────  tab bar top edge
//
// The slot-filling Pressable is the hit target (kept within the tab-bar
// bounds); the circle is a pointerEvents="none" visual child translated up.

const DOUBLE_TAP_MS = 600

export function RecordTabButton(_props: BottomTabBarButtonProps): React.JSX.Element {
  // Guard against a double-tap creating two impromptu meetings. The
  // orchestrator also bails when a recording is already in flight
  // (store.status !== 'idle'); this is the first line.
  const lastPressRef = useRef(0)
  const queryClient = useQueryClient()

  const handlePress = (): void => {
    const now = Date.now()
    if (now - lastPressRef.current < DOUBLE_TAP_MS) return
    lastPressRef.current = now
    void startImpromptuRecording(queryClient)
  }

  return (
    <Pressable
      onPress={handlePress}
      style={styles.slot}
      accessibilityRole="button"
      accessibilityLabel="New meeting"
    >
      <View style={styles.circle} pointerEvents="none">
        <Image
          source={require('../assets/cyggie-swan-button.png')}
          style={styles.swan}
          resizeMode="contain"
        />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  slot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  circle: {
    // Lift the circle so its top third rises above the tab bar's top edge.
    marginTop: -18,
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    // Neutral drop shadow so a white circle reads against the near-white bar.
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 10,
    elevation: 8,
  },
  swan: {
    width: 36,
    height: 36,
  },
})
