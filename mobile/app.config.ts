import type { ExpoConfig } from 'expo/config'

// Expo / EAS configuration. Edit values here; do not hand-roll app.json.
// Bundle ID + URL scheme are deliberately tight — `cyggie://` is what the
// gateway redirects to after OAuth, and what the invite magic-link uses
// (cyggie://invite/<token>). Changing either breaks the auth round-trip.

const config: ExpoConfig = {
  name: 'Cyggie',
  slug: 'cyggie',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: 'cyggie',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  ios: {
    bundleIdentifier: 'com.cyggie.mobile',
    supportsTablet: false,
    // Background audio entitlement lands in M3 alongside the recording pipeline.
  },
  experiments: {
    typedRoutes: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-web-browser',
  ],
  extra: {
    // Gateway URL surfaces at runtime via expo-constants. Override per-env via
    // EAS Build profiles (eas.json — lands in M6 before TestFlight).
    gatewayUrl: process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev',
  },
}

export default config
