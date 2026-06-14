import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { colors, radii, spacing, type } from '../theme'
import { ChatHeaderButton } from './ChatHeaderButton'

// Shared top app bar for the main screens. Extracted from the five hand-rolled
// `appbar` blocks that used to live in each tab screen so a header change is a
// single-file edit. Renders ONLY the app-bar row — screens keep their own
// <SafeAreaView> wrapper and any search / filter / segment rows below it.
//
//   ┌─────────────────────────────────────────────────────────┐
//   │ [‹ back?]  Title                       [actions…] [💬]   │
//   │            Subtitle                                       │
//   └─────────────────────────────────────────────────────────┘
//
// The chat bubble is appended automatically (showChatButton, default true) so
// global "Ask Cyggie" is reachable from every main screen — it replaced the
// old Chat tab when Record took the center tab slot.

export interface ScreenHeaderProps {
  title: string
  subtitle?: string
  /** When set, renders a leading back chevron (pushed screens, e.g. chat). */
  onBack?: () => void
  /** Screen-specific trailing buttons (e.g. search / settings). Rendered left
   *  of the chat button. Screens pass their own icons so existing sizes/colors
   *  are preserved — ScreenHeader does not force a size on these. */
  actions?: React.ReactNode
  /** Appends the persistent chat button. Off on the chat screen itself. */
  showChatButton?: boolean
  /** Hairline bottom border (screens with no search/segment row below). */
  borderBottom?: boolean
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  actions,
  showChatButton = true,
  borderBottom = false,
}: ScreenHeaderProps): React.JSX.Element {
  const hasTrailing = Boolean(actions) || showChatButton
  return (
    <View style={[styles.appbar, borderBottom && styles.appbarBorder]}>
      {onBack && (
        <Pressable
          onPress={onBack}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
        >
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
      )}
      <View style={styles.appbarTitleWrap}>
        <Text style={styles.appbarTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.appbarSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {hasTrailing && (
        <View style={styles.appbarActions}>
          {actions}
          {showChatButton && <ChatHeaderButton />}
        </View>
      )}
    </View>
  )
}

// Round icon button used for header actions (search, settings, new-chat, the
// chat bubble). Matches the Calendar app bar's original `iconButton` look so
// every header action reads the same across screens.
export interface HeaderIconButtonProps {
  icon: keyof typeof Ionicons.glyphMap
  onPress: () => void
  accessibilityLabel: string
  disabled?: boolean
  size?: number
}

export function HeaderIconButton({
  icon,
  onPress,
  accessibilityLabel,
  disabled,
  size = 18,
}: HeaderIconButtonProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => [
        styles.iconButton,
        disabled && styles.iconDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Ionicons name={icon} size={size} color={colors.text2} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  appbar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    backgroundColor: colors.surface,
  },
  appbarBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backBtn: {
    marginLeft: -spacing.xs,
    height: 34,
    justifyContent: 'center',
  },
  appbarTitleWrap: { flex: 1, minWidth: 0 },
  appbarTitle: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.6,
    lineHeight: 28,
  },
  appbarSubtitle: {
    color: colors.text3,
    fontSize: type.meta + 1,
    fontWeight: '500',
    marginTop: 2,
  },
  appbarActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDisabled: { opacity: 0.35 },
  pressed: { opacity: 0.6 },
})
