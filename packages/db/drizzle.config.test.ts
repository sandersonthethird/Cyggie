import { defineConfig } from 'drizzle-kit'

// Test-only drizzle config used by the api-gateway vitest globalSetup to
// `push` the current schema into an ephemeral local Postgres.
//
// Differences from the prod drizzle.config.ts:
//   - Does NOT load .env.local — GATEWAY_DATABASE_URL is injected by the
//     harness and points at the embedded Postgres (127.0.0.1:<TEST_PG_PORT>).
//   - strict: false + verbose: false so `push --force` applies the schema
//     fully non-interactively (no confirmation prompt to hang the test run).
//
// Same schema + dialect as prod, so the resulting tables/indexes are identical
// to what `drizzle-kit push` would produce against Neon.
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env['GATEWAY_DATABASE_URL'] ??
      'postgresql://invalid:invalid@invalid/invalid',
  },
  strict: false,
  verbose: false,
})
