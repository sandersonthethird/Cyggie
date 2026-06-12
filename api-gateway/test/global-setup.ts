import EmbeddedPostgres from 'embedded-postgres'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { assertPortAvailable } from './_helpers/port'

// ─────────────────────────────────────────────────────────────────────────────
// vitest globalSetup for the `api-gateway` project (Part 2 of the test-DB
// plan). Boots an ephemeral local Postgres and pushes the current Drizzle
// schema into it, so the ~40 gateway DB tests run fully locally instead of
// against live Neon — faster, offline-capable, no shared-branch pollution.
//
//   boot flow
//   ─────────
//   assertPortAvailable(PORT)          ← loud, actionable if taken (Issue 6A/9A)
//        │
//   EmbeddedPostgres.initialise()      ← initdb into a fresh cache dir
//        │  .start()                   ← cluster up on 127.0.0.1:PORT
//        │  .createDatabase(DB)
//        ▼
//   drizzle-kit push --force           ← build schema from TS (Issue 1A);
//   (drizzle.config.test.ts)             immune to migration journal drift
//        ▼
//   tests connect via GATEWAY_DATABASE_URL (set in vitest.config test.env)
//        ▼
//   teardown(): pg.stop() + rm dataDir ← runs even if the suite fails
//
// Fixed port (TEST_PG_PORT overridable) because the hermetic test.env URL must
// be static — workers can't learn a dynamic port across the process boundary.
// ─────────────────────────────────────────────────────────────────────────────

const PORT = Number(process.env['TEST_PG_PORT'] ?? 54329)
const USER = 'postgres'
const PASSWORD = 'postgres'
const DB = 'cyggie_test'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const dbPkgDir = resolve(repoRoot, 'packages/db')
const drizzleKitBin = resolve(repoRoot, 'node_modules/.bin/drizzle-kit')
// Fresh data dir each run → empty DB → push builds the full schema clean.
// Port-scoped so concurrent runs on different TEST_PG_PORT (e.g. parallel
// migration verification) don't clobber each other's cluster.
const dataDir = resolve(repoRoot, `node_modules/.cache/embedded-pg-test-${PORT}`)

export default async function setup(): Promise<() => Promise<void>> {
  await assertPortAvailable(PORT)
  rmSync(dataDir, { recursive: true, force: true })

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: false, // stop() wipes the cluster — no cross-run leakage
    onLog: () => {}, // silence initdb/postgres chatter in test output
    onError: (e) => console.error('[test-db]', e),
  })

  await pg.initialise()
  await pg.start()
  await pg.createDatabase(DB)

  const url = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`

  // Build the schema from the current Drizzle TS definition (Issue 1A) — NOT a
  // migration replay. Uses the test-only drizzle config (strict:false) so
  // --force applies everything non-interactively.
  execFileSync(
    drizzleKitBin,
    ['push', '--force', '--config', 'drizzle.config.test.ts'],
    {
      cwd: dbPkgDir,
      env: { ...process.env, GATEWAY_DATABASE_URL: url },
      stdio: ['ignore', 'ignore', 'inherit'], // surface push errors only
    },
  )

  return async function teardown(): Promise<void> {
    await pg.stop()
    rmSync(dataDir, { recursive: true, force: true })
  }
}
