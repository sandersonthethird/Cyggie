import { StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { colors, radii, type } from '../theme'

// Initials avatar — wireframe shows this in the top-right of the app bar
// (Calendar, Companies, Chat) and again in meeting attendee lists.
//
// V1 uses initials only — wiring a real profile photo requires an extra
// network call per render and image-cache management; both come in M6.

export interface AvatarProps {
  initials: string
  size?: number
  /** Optional override for a deterministic per-user hue. Defaults to slate. */
  color?: string
  style?: ViewStyle
}

export function Avatar({ initials, size = 32, color = '#94A3B8', style }: AvatarProps) {
  return (
    <View
      style={[
        styles.root,
        {
          width: size,
          height: size,
          borderRadius: radii.pill,
          backgroundColor: color,
        },
        style,
      ]}
    >
      <Text
        style={[
          styles.text,
          { fontSize: size <= 24 ? type.label : size <= 36 ? type.meta : type.body },
        ]}
        numberOfLines={1}
      >
        {(initials.slice(0, 2) || '?').toUpperCase()}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: colors.surface,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
})
