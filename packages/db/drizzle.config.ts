import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Load .env.local from the repo root (two levels up from packages/db/).
// Production uses Fly secrets directly — this file is dev/local only.
const __dirname = dirname(fileURLToPath(import.meta.url))
config({ path: resolve(__dirname, '../../.env.local') })

// Gateway-side database config. The mobile gateway + future web client + (eventually)
// desktop all read/write to this Postgres database via the @cyggie/db package.
//
// V1 target: Neon Postgres (separate project from `web/`'s share-token DB).
//
// Connection string is supplied via GATEWAY_DATABASE_URL env var. drizzle-kit will
// refuse to run migrations against a real DB without it; that's intentional — we want
// explicit opt-in for any push/migrate operation.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['GATEWAY_DATABASE_URL'] ?? 'postgresql://invalid:invalid@invalid/invalid',
  },
  // Strict mode catches schema drift between TS and the live DB. Always strict in CI.
  strict: true,
  verbose: true,
})
