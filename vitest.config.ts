import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const root = resolve(fileURLToPath(import.meta.url), '..')

// Fixed port for the ephemeral test Postgres (see api-gateway/test/global-setup.ts).
// Overridable via TEST_PG_PORT; the gateway project's GATEWAY_DATABASE_URL below
// is derived from the SAME value so global-setup and the test env stay in sync.
const TEST_PG_PORT = process.env['TEST_PG_PORT'] ?? '54329'
const TEST_PG_URL = `postgresql://postgres:postgres@127.0.0.1:${TEST_PG_PORT}/cyggie_test`

const alias = {
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

// Two projects (Issue 10A): the `api-gateway` project boots an ephemeral
// Postgres via globalSetup; the `default` project (desktop/renderer/mobile —
// ~350 pure-logic tests) does NOT, so a targeted non-gateway run pays zero PG
// cost. Both inherit the root plugins + resolve.alias via `extends: true`.
export default defineConfig({
  plugins: [react()],
  // RN's `__DEV__` global isn't defined under node. Stub to false so mobile
  // modules that gate diagnostic code on it (e.g. oauth.ts) load cleanly.
  define: { __DEV__: 'false' },
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'default',
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
            // Mobile pure-JS unit tests. Tests covering React-Native-specific
            // surfaces (UI rendering, native modules) belong in a separate
            // mobile-side runner that knows how to mock the RN bridge — these
            // tests only exercise plain TS modules with mocked file-system and
            // MMKV, so the root node runner is fine for them.
            'mobile/lib/**/__tests__/**/*.test.ts',
            // Mobile component-adjacent hook tests. These use renderHook from
            // @testing-library/react under jsdom (opt-in per-file via
            // `// @vitest-environment jsdom`) — pure hook contracts only, no
            // React Native UI rendering.
            'mobile/components/**/__tests__/**/*.test.{ts,tsx}',
          ],
          // Default placeholder values for M3-newly-required env vars.
          // Individual tests can override (e.g. recordings-quota.test.ts).
          env: {
            DEEPGRAM_API_KEY: 'test-deepgram-key',
            DEEPGRAM_WEBHOOK_SECRET: 'test-webhook-secret-at-least-16-chars',
            // AES-256-GCM key for Google refresh-token encryption (decodes to
            // 32 bytes). Test-only default so loadEnv() doesn't throw.
            GOOGLE_TOKEN_ENC_KEY: 'Y3lnZ2llLXZpdGVzdC1kZWZhdWx0LWdvb2dsZS1rZXk=',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'api-gateway',
          environment: 'node',
          include: ['api-gateway/test/**/*.test.ts'],
          // Boots embedded Postgres + pushes the schema once for this project.
          globalSetup: ['./api-gateway/test/global-setup.ts'],
          // Hermetic gateway env (Issue 3A): every var loadEnv() requires,
          // with dummy test values, so the suite runs with ZERO .env.local.
          // The per-file `loadDotenv({ path: '.env.local' })` calls use no
          // `override`, so these win even when .env.local is present —
          // pointing the DB at the local embedded Postgres, never Neon.
          env: {
            GATEWAY_DATABASE_URL: TEST_PG_URL,
            JWT_SIGNING_SECRET: 'test-jwt-signing-secret-32-bytes-minimum-len!!',
            GOOGLE_TOKEN_ENC_KEY: 'Y3lnZ2llLXZpdGVzdC1kZWZhdWx0LWdvb2dsZS1rZXk=',
            GOOGLE_CLIENT_ID: 'test-google-client-id',
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
            GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:8443/auth/google/callback',
            DEEPGRAM_API_KEY: 'test-deepgram-key',
            DEEPGRAM_WEBHOOK_SECRET: 'test-webhook-secret-at-least-16-chars',
          },
        },
      },
    ],
  },
})
