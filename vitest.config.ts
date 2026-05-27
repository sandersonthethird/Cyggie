import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const root = resolve(fileURLToPath(import.meta.url), '..')

export default defineConfig({
  plugins: [react()],
  // RN's `__DEV__` global isn't defined under node. Stub to false so
  // mobile modules that gate diagnostic code on it (e.g. oauth.ts)
  // load cleanly under the test runner.
  define: { __DEV__: 'false' },
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      '@renderer': resolve(root, 'src/renderer'),
      '@cyggie/db': resolve(root, 'packages/db/src'),
      '@cyggie/services': resolve(root, 'packages/services/src'),
      '@cyggie/shared': resolve(root, 'packages/shared/src'),
      // Test-only stub for `react-native`. Mobile pure-logic tests touch
      // modules whose transitive imports pull RN's Flow-typed index.js,
      // which rollup can't parse. The stub gives the parse path something
      // ESM-friendly while letting individual tests vi.mock specific RN
      // surfaces they actually exercise.
      'react-native': resolve(root, 'mobile/lib/__tests__/_stubs/react-native.ts'),
      // Expo native modules — same story. The chat client transitively
      // imports auth/oauth.ts (uses expo-web-browser) + auth/storage.ts
      // (expo-secure-store) + auth/device.ts (expo-crypto). Stub each so
      // the import chain resolves; individual tests vi.mock the surfaces
      // they need.
      'expo-web-browser': resolve(root, 'mobile/lib/__tests__/_stubs/expo-empty.ts'),
      'expo-secure-store': resolve(root, 'mobile/lib/__tests__/_stubs/expo-empty.ts'),
      'expo-crypto': resolve(root, 'mobile/lib/__tests__/_stubs/expo-empty.ts'),
    }
  },
  test: {
    environment: 'node',
    include: [
      'src/tests/**/*.test.{ts,tsx}',
      // Co-located unit tests inside the workspace packages — pure
      // logic with no DB / IPC / React.
      'packages/services/src/**/*.test.ts',
      // Renderer co-located tests (2026-05-24). Pure-JS modules in the
      // renderer (no React rendering needed) live next to their source
      // under src/renderer/**/__tests__/. The `// @vitest-environment
      // jsdom` directive at the top of any file opts that file into a
      // jsdom env for React renderHook etc.
      'src/renderer/**/__tests__/**/*.test.{ts,tsx}',
      'web/middleware.test.ts',
      'api-gateway/test/**/*.test.ts',
      // Mobile pure-JS unit tests. Tests covering React-Native-specific
      // surfaces (UI rendering, native modules) belong in a separate
      // mobile-side runner that knows how to mock the RN bridge — these
      // tests only exercise plain TS modules with mocked file-system and
      // MMKV, so the root node runner is fine for them.
      'mobile/lib/**/__tests__/**/*.test.ts',
      // Mobile component-adjacent hook tests. These use renderHook from
      // @testing-library/react under jsdom (opt-in per-file via
      // `// @vitest-environment jsdom`) — pure hook contracts only, no
      // React Native UI rendering. Tests that need actual RN UI still
      // belong in a future mobile-side runner.
      'mobile/components/**/__tests__/**/*.test.{ts,tsx}'
    ],
    // Default placeholder values for M3-newly-required env vars. Individual
    // tests can override (e.g. recordings-quota.test.ts sets a lower quota).
    // The .env.local at the repo root still wins for any var listed there.
    env: {
      DEEPGRAM_API_KEY: 'test-deepgram-key',
      DEEPGRAM_WEBHOOK_SECRET: 'test-webhook-secret-at-least-16-chars'
    }
  }
})
