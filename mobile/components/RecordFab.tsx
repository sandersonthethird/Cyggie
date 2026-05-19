import { useEffect, useRef } from 'react'
import { Alert, Animated, Easing, Pressable, StyleSheet, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radii } from '../theme'

// Crimson pencil FAB from WIREFRAME 1. Pinned bottom-right above the tab
// bar. M3 wires the actual recording start; today it confirms the affordance
// is plumbed and the pulse + tap-target are sized right.
//
//   • The pulse ring is the wireframe's expanding outline (fabPulse keyframe)
//     — slow (2.4s), eased out, infinite. Subtle attention-grabber.
//   • Hit area is 64px even though the visual is 56px so partners with
//     gloves / cold hands have something to land on between meetings.

export interface RecordFabProps {
  /** Override the press action — M3 rewires this to start a recording. */
  onPress?: () => void
}

export function RecordFab({ onPress }: RecordFabProps) {
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2400,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    )
    animation.start()
    return () => animation.stop()
  }, [pulse])

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.4] })
  const ringOpacity = pulse.interpolate({
    inputRange: [0, 0.8, 1],
    outputRange: [0.7, 0, 0],
  })

  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={styles.hitArea}>
        <Animated.View
          style={[
            styles.ring,
            { transform: [{ scale: ringScale }], opacity: ringOpacity },
          ]}
          pointerEvents="none"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start recording"
          onPress={onPress ?? defaultOnPress}
          style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
        >
          <Ionicons name="pencil" size={22} color={colors.surface} />
        </Pressable>
      </View>
    </View>
  )
}

function defaultOnPress(): void {
  Alert.alert(
    'Recording is coming in M3',
    "We're staging the FAB now so every screen has the affordance — the recorder itself lands in the next milestone.",
    [{ text: 'OK' }],
  )
}

const styles = StyleSheet.create({
  // pointerEvents='box-none' on the wrapper lets taps on the rest of the
  // screen pass through unimpeded — only the FAB's own hit area intercepts.
  root: {
    position: 'absolute',
    bottom: 110, // above the tab bar (60px) + breathing room
    right: 18,
  },
  hitArea: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: radii.pill,
    backgroundColor: colors.crimson,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.crimson,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 8,
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  ring: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.crimson,
  },
})
