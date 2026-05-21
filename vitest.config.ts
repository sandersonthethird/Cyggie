import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const root = resolve(fileURLToPath(import.meta.url), '..')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
      '@renderer': resolve(root, 'src/renderer'),
      '@cyggie/db': resolve(root, 'packages/db/src'),
      '@cyggie/services': resolve(root, 'packages/services/src'),
      '@cyggie/shared': resolve(root, 'packages/shared/src')
    }
  },
  test: {
    environment: 'node',
    include: [
      'src/tests/**/*.test.{ts,tsx}',
      'web/middleware.test.ts',
      'api-gateway/test/**/*.test.ts',
      // Mobile pure-JS unit tests. Tests covering React-Native-specific
      // surfaces (UI rendering, native modules) belong in a separate
      // mobile-side runner that knows how to mock the RN bridge — these
      // tests only exercise plain TS modules with mocked file-system and
      // MMKV, so the root node runner is fine for them.
      'mobile/lib/**/__tests__/**/*.test.ts'
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
