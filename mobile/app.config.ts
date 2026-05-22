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
  runtimeVersion: {
    policy: 'appVersion',
  },
  updates: {
    url: 'https://u.expo.dev/89a313ae-ea7b-4694-8bed-44218370b9cc',
  },
  ios: {
    bundleIdentifier: 'com.cyggie.mobile',
    supportsTablet: false,
    // M3 — recording entitlements + permission strings.
    //
    // UIBackgroundModes:audio lets a recording survive backgrounding (user
    // locks phone or switches apps mid-meeting). NSMicrophoneUsageDescription
    // is the prompt iOS shows on first record attempt.
    infoPlist: {
      UIBackgroundModes: ['audio'],
      NSMicrophoneUsageDescription:
        'Cyggie records meetings so they can be transcribed and summarized.',
    },
  },
  experiments: {
    typedRoutes: true,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-web-browser',
    // Required by @expo/vector-icons (Ionicons fonts) — autolinking only
    // picks up direct deps, hence the explicit install + plugin entry.
    'expo-font',
    // M3 push notifications. Icon/color defaults are fine for V1;
    // branding tightening lands in M6 polish.
    ['expo-notifications', { sounds: [] }],
  ],
  extra: {
    // Gateway URL surfaces at runtime via expo-constants. Override per-env via
    // EAS Build profiles (eas.json — lands in M6 before TestFlight).
    gatewayUrl: process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev',
    eas: {
      projectId: '89a313ae-ea7b-4694-8bed-44218370b9cc',
    },
  },
}

export default config
