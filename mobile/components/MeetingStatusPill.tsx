// =============================================================================
// MeetingStatusPill.tsx — small status badge shared by the calendar list
// meeting cards and the meeting detail Hero. Surfaces non-obvious states
// ('transcribing' / 'empty' / 'error'); renders nothing otherwise.
//
// The status→{label,tone} mapping lives in lib/meetings/status-pill.ts
// as a pure function so it can be tested without a React renderer.
// This component just maps the tone to colors + renders.
// =============================================================================

import { StyleSheet, Text, View } from 'react-native'
import { decideStatusPill, type PillTone } from '../lib/meetings/status-pill'
import { colors, radii, spacing, type } from '../theme'

interface MeetingStatusPillProps {
  status: string | undefined | null
  /** When true, padding/font shrink slightly for use inside compact cards. */
  compact?: boolean
}

export function MeetingStatusPill({ status, compact }: MeetingStatusPillProps) {
  const pill = decideStatusPill(status)
  if (!pill) return null
  const toneStyle = TONE_STYLES[pill.tone]
  return (
    <View
      style={[
        styles.pill,
        compact && styles.pillCompact,
        { backgroundColor: toneStyle.bg, borderColor: toneStyle.border },
      ]}
      accessibilityRole="text"
      accessibilityLabel={`Meeting status: ${pill.label}`}
    >
      <Text style={[styles.label, { color: toneStyle.fg }]}>{pill.label}</Text>
    </View>
  )
}

const TONE_STYLES: Record<PillTone, { fg: string; bg: string; border: string }> = {
  info: { fg: colors.text2, bg: colors.surface3, border: colors.border },
  warning: { fg: colors.warning, bg: '#FEF3C7', border: '#FDE68A' },
  error: { fg: colors.crimson, bg: '#FEE2E2', border: '#FECACA' },
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  pillCompact: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
  },
  label: {
    fontSize: type.caption,
    fontWeight: '600',
  },
})
