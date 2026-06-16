import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, type ViewStyle } from 'react-native'

// =============================================================================
// KeyboardAvoidingScreen — the canonical keyboard-avoidance wrapper.
//
// One source of truth so screens don't re-derive (and drift on) the behavior /
// offset every time. Use it as the OUTERMOST element of a screen, wrapping the
// topbar + ScrollView:
//
//   <KeyboardAvoidingScreen style={styles.root}>
//     <SafeAreaView>…topbar…</SafeAreaView>
//     <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">…</ScrollView>
//   </KeyboardAvoidingScreen>
//
// When the wrapper's top edge is the screen top (the root-wrap case above), the
// offset is 0 — there is no header above it to compensate for. DON'T copy a
// magic per-screen constant here; if a call site sits BELOW a fixed header
// (e.g. ChatComposer under the chat appbar), pass `offset` = that header height.
//
// Android: behavior is left undefined so the native windowSoftInputMode
// (adjustResize) drives the resize — 'height'/'padding' on Android tends to
// fight the native resize and produce visible jank.
// =============================================================================

export function KeyboardAvoidingScreen({
  children,
  style,
  offset = 0,
}: {
  children: ReactNode
  style?: ViewStyle
  offset?: number
}) {
  return (
    <KeyboardAvoidingView
      style={style}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? offset : 0}
    >
      {children}
    </KeyboardAvoidingView>
  )
}
