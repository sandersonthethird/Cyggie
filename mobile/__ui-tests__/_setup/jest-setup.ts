// =============================================================================
// jest-setup.ts — runs once per test file AFTER the jest framework is set up.
// Wired via jest.config.js → setupFilesAfterEnv.
//
// Responsibilities:
//   1. Extend jest's `expect` with React-Native-flavored matchers
//      (toBeOnTheScreen, toHaveTextContent, toBeDisabled, etc.) — required
//      by every UI test.
//   2. Mock react-native-reanimated v4 + its worklets dep. jest-expo's
//      preset handles older reanimated v2/v3 out of the box but v4 split
//      worklets into a separate package whose native binding fails to
//      initialize in node. The official `react-native-reanimated/mock`
//      shim covers the Animated API surface; we also stub worklets so
//      reanimated's import chain doesn't crash.
//   3. Stub react-native-gesture-handler. ReanimatedSwipeable (used by
//      MeetingRow for swipe-to-dismiss) pulls in the gesture handler
//      package which expects native bindings.
// =============================================================================

import '@testing-library/jest-native/extend-expect'

// Inline mock for react-native-reanimated (instead of using the package's
// own /mock entry point, which itself imports worklets and trips on
// `createSerializable`). We only stub what our components actually pull in
// — currently MeetingRow uses `runOnJS`, `useAnimatedReaction`, and the
// `SharedValue` type. The type import is erased at compile time so the
// mock only needs the runtime functions.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: {},
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useAnimatedReaction: () => {},
  useSharedValue: (initial: unknown) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
  withSpring: (v: unknown) => v,
  Easing: { linear: () => 0, ease: () => 0 },
}))

jest.mock('react-native-worklets', () => ({
  createSerializable: (v: unknown) => v,
  createWorkletRuntime: () => ({}),
  runOnUI: (fn: () => void) => fn,
  runOnJS: (fn: () => void) => fn,
  isWorkletFunction: () => false,
  __WORKLETS_VERSION: 'mock',
}))

jest.mock('react-native-gesture-handler', () => {
  const View = require('react-native').View
  return {
    Swipeable: View,
    DrawerLayout: View,
    State: {},
    ScrollView: View,
    Slider: View,
    Switch: View,
    TextInput: View,
    ToolbarAndroid: View,
    ViewPagerAndroid: View,
    DrawerLayoutAndroid: View,
    WebView: View,
    NativeViewGestureHandler: View,
    TapGestureHandler: View,
    FlingGestureHandler: View,
    ForceTouchGestureHandler: View,
    LongPressGestureHandler: View,
    PanGestureHandler: View,
    PinchGestureHandler: View,
    RotationGestureHandler: View,
    RawButton: View,
    BaseButton: View,
    RectButton: View,
    BorderlessButton: View,
    FlatList: View,
    gestureHandlerRootHOC: jest.fn(),
    Directions: {},
    GestureHandlerRootView: View,
  }
})

// ReanimatedSwipeable lives at react-native-gesture-handler/ReanimatedSwipeable
// — a deep import path that bypasses the package mock above. Stub it directly.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = require('react')
  const View = require('react-native').View
  // Wrap children in a View so RNTL queries can still find them.
  const ReanimatedSwipeable = ({ children }: { children: React.ReactNode }) =>
    React.createElement(View, null, children)
  return { __esModule: true, default: ReanimatedSwipeable }
})
