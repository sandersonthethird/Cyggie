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
    include: ['src/tests/**/*.test.{ts,tsx}', 'web/middleware.test.ts']
  }
})
