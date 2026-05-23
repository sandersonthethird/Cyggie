// Central design tokens for the mobile app.
//
// Sourced from docs/DESIGN.md (light mode, Inter, crimson accent, level-1
// roundedness, level-2 spacing) and the Calendar Home wireframe in
// "Cyggie Mobile - Wireframes.html".
//
// Import these tokens rather than hard-coding hex / pixel values in each
// screen so future theming work (M6 polish, eventual dark mode) is a
// single-file change.

import { Platform } from 'react-native'

export const colors = {
  // Surfaces
  bg: '#EEF0F3',
  surface: '#FFFFFF',
  surface2: '#FAFBFC',
  surface3: '#F4F5F7',
  // Borders
  border: '#E5E7EB',
  borderSoft: '#EEF0F3',
  borderStrong: '#D1D5DB',
  // Text
  text: '#0F172A',
  text2: '#374151',
  text3: '#6B7280',
  text4: '#9CA3AF',
  // Crimson accent — record, next-meeting border, now-rail dot, key-takeaways
  crimson: '#B91C1C',
  crimsonDeep: '#7F1D1D',
  crimsonMuted: '#FEF2F2',
  // Recording red (slightly brighter than crimson for active states)
  rec: '#DC2626',
  // Semantic
  success: '#047857',
  warning: '#92400E',
  // Companion fills used for org/contact chips on detail screens (M2 wires
  // these; included now so MeetingRow can stub a slot consistently)
  chipViolet: '#7C3AED',
  chipSky: '#0369A1',
  chipSkyMuted: '#E0F2FE',
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 14,
  pill: 99,
} as const

// Type sizes mapped to the wireframe's pixel ladder.
export const type = {
  display: 26,
  h1: 22,
  h2: 18,
  body: 14,
  bodyTight: 13.5,
  meta: 11.5,
  label: 10.5,
  caption: 10,
} as const

export const fonts = {
  // Inter is the brand font per docs/DESIGN.md, but a custom font requires
  // expo-font + a load step in the root layout — defer to M6 polish.
  // System gets us close enough on iOS (SF Pro) without that load cost.
  regular: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }),
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
} as const

// Convenience: the canonical "card" surface used by AI cards / list groups.
export const card = {
  backgroundColor: colors.surface,
  borderColor: colors.border,
  borderWidth: 1,
  borderRadius: radii.xl,
} as const
