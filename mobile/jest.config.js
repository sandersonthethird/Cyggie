// =============================================================================
// jest.config.js — second test runner for RN UI rendering tests (MC.runner).
//
// Coexists with the root vitest runner:
//   • vitest (repo root)    → pure-JS unit + hook tests under
//                              mobile/lib/__tests__/ and
//                              mobile/components/__tests__/
//   • jest    (this file)   → React-Native UI rendering tests under
//                              mobile/**/__ui-tests__/**
//
// The two runners never see the same files because they look in different
// directories. Don't put `.test.tsx` files under both — pick `__ui-tests__/`
// for anything that calls `render(<Foo />)` from @testing-library/react-native.
//
// Why jest-expo and not vitest-react-native: jest-expo is the Expo-canonical
// preset. It ships RN bridge mocks (AsyncStorage, expo-modules, navigation
// stacks) and a `react-native-reanimated/mock` shim that handles RNs v4 JSI
// surface. The vitest plugin alternatives don't yet document Expo SDK 54
// support.
// =============================================================================

module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/**/__ui-tests__/**/*.test.{ts,tsx}'],
  setupFilesAfterEnv: ['<rootDir>/__ui-tests__/_setup/jest-setup.ts'],
  transformIgnorePatterns: [
    // jest-expo's default allowlist extended with @react-navigation + a few
    // ESM-only RN packages we touch. Anything matching this regex is left
    // un-transformed; everything else is run through babel-jest.
    'node_modules/(?!((jest-)?react-native|@react-native|@react-navigation|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-clone-referenced-element|@sentry/.*|sentry-expo|native-base|react-native-svg|react-native-reanimated))',
  ],
}
