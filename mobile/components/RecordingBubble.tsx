// =============================================================================
// RecordingBubble — global floating recording indicator.
//
// Mounted once in the root layout. While a recording is ACTIVE and the user is
// somewhere OTHER than that meeting's view, it floats above the tab bar showing
// a pulsing dot + live timer ("<title> · tap to view"). Tapping returns to the
// meeting view; the Stop button stops + uploads in place.
//
// Visibility (all must hold):
//   • store.status === 'recording'         (only while actively recording —
//                                            vanishes the instant Stop is hit)
//   • store.activeMeetingId is set
//   • current route !== that meeting's view (don't double up with the in-view
//     RecordingBanner)
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, usePathname } from 'expo-router'
import { useRecordingStore } from '../lib/recording/store'
import { stopRecording } from '../lib/recording/session'
import { formatElapsed } from '../lib/recording/format-elapsed'
import { shouldShowRecordingBubble } from '../lib/recording/bubble-visibility'
import { colors, radii, spacing, type } from '../theme'

export function RecordingBubble(): React.JSX.Element | null {
  const status = useRecordingStore((s) => s.status)
  const activeMeetingId = useRecordingStore((s) => s.activeMeetingId)
  const activeTitle = useRecordingStore((s) => s.activeTitle)
  const startedAt = useRecordingStore((s) => s.startedAt)
  const pathname = usePathname()
  const insets = useSafeAreaInsets()

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (status !== 'recording' || !startedAt) return
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    tick()
    const h = setInterval(tick, 1000)
    return () => clearInterval(h)
  }, [status, startedAt])

  // Pulsing dot.
  const pulse = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (status !== 'recording') return
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [status, pulse])

  if (!shouldShowRecordingBubble({ status, activeMeetingId, pathname })) return null

  const bottom = (Platform.OS === 'ios' ? 96 : 72) + Math.max(0, insets.bottom - 12)

  return (
    <Pressable
      onPress={() => router.push(`/meetings/${activeMeetingId}` as never)}
      style={[styles.bubble, { bottom }]}
      accessibilityRole="button"
      accessibilityLabel="Return to recording meeting"
    >
      <Animated.View style={[styles.dot, { opacity: pulse }]} />
      <View style={styles.textCol}>
        <Text style={styles.title} numberOfLines={1}>
          Recording
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {(activeTitle ?? 'Meeting') + ' · tap to view'}
        </Text>
      </View>
      <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
      <Pressable
        onPress={() => {
          // Uses the session's stashed context (meetingId/calEventId/title),
          // so no args needed here.
          void stopRecording({}).catch(() => {
            // markError already fired; the meeting view surfaces the retry UI.
          })
        }}
        hitSlop={8}
        style={({ pressed }) => [styles.stopBtn, pressed && { opacity: 0.85 }]}
        accessibilityRole="button"
        accessibilityLabel="Stop recording"
      >
        <View style={styles.stopSquare} />
      </Pressable>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.crimson,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 8,
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.crimson },
  textCol: { flex: 1 },
  title: { color: colors.crimson, fontSize: type.bodyTight, fontWeight: '700' },
  subtitle: { color: colors.text3, fontSize: type.caption, marginTop: 1 },
  timer: {
    color: colors.text,
    fontSize: type.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stopBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.crimson,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopSquare: { width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' },
})
