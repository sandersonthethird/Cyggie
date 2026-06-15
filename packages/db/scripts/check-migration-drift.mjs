#!/usr/bin/env node
// Drift guard (Issue #27): fail when the Drizzle schema has changes that haven't
// been captured in a generated Postgres migration — the exact gap that shipped
// `notes.is_private` to prod without a migration and broke note editing.
//
// HOW (offline — no DB):
//   1. copy migrations/ (journal + snapshots = the diff baseline) into a tempdir
//      INSIDE packages/db (so `out`/`schema` stay RELATIVE to cwd — drizzle-kit
//      mangles absolute `out` paths and would silently fail-open on real drift)
//   2. run `drizzle-kit generate` with a temp config whose `out` is that tempdir
//   3. if generate writes a NEW .sql there, the schema has ungenerated changes
//
//        schema TS ──┐
//        snapshots ──┴─▶ drizzle-kit generate ─▶ new .sql?  ── yes ─▶ exit 1 (block)
//                                              │              no  ─▶ exit 0 (clean)
//                                              └─ error/timeout ──▶ warn, exit 0 (fail-open)
//
// FAIL-OPEN (per plan-eng-review): only a confidently-detected new migration
// blocks; a drizzle-kit error/timeout/prompt warns and allows, so the hook can't
// get `--no-verify`'d into uselessness over its own hiccups.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dbDir = resolve(dirname(fileURLToPath(import.meta.url)), '..') // packages/db
const realMigrations = join(dbDir, 'migrations')
const sqlNames = (dir) => new Set(readdirSync(dir).filter((f) => f.endsWith('.sql')))

let tmp // module-scoped so the finally can always clean it up

function main() {
  tmp = mkdtempSync(join(dbDir, '.drift-'))
  const outDir = join(tmp, 'migrations')
  cpSync(realMigrations, outDir, { recursive: true })
  const before = sqlNames(outDir)

  // Relative paths (cwd=dbDir), mirroring the real drizzle.config.ts. Dummy URL
  // — generate is offline (diffs schema vs snapshot, never connects).
  const cfgPath = join(tmp, 'drift.config.ts')
  writeFileSync(
    cfgPath,
    `export default ${JSON.stringify({
      schema: './src/schema/index.ts',
      out: './' + relative(dbDir, outDir),
      dialect: 'postgresql',
      dbCredentials: { url: 'postgresql://invalid:invalid@invalid/invalid' },
    })}\n`,
  )

  // Resolve drizzle-kit's bin robustly (npm/pnpm layouts differ, and its
  // `exports` blocks requiring package.json): resolve the main entry, find the
  // package root in the path, read package.json via fs, then run bin with node.
  const require = createRequire(import.meta.url)
  const mainPath = require.resolve('drizzle-kit') // follows pnpm symlinks
  const marker = join('node_modules', 'drizzle-kit')
  const pkgRoot = mainPath.slice(0, mainPath.lastIndexOf(marker) + marker.length)
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  const binJs = join(pkgRoot, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['drizzle-kit'])

  try {
    execFileSync(process.execPath, [binJs, 'generate', '--config', cfgPath], {
      cwd: dbDir,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin closed → an interactive prompt can't hang us
      timeout: 60_000,
    })
  } catch (err) {
    // Non-zero exit, timeout, or a rename prompt that hit closed stdin → can't
    // reach a confident verdict. Fail-open: warn and allow the push.
    console.warn(
      '⚠️  migration-drift check could not run (drizzle-kit error/timeout) — allowing push.\n' +
        `   ${err?.shortMessage || err?.message || err}\n` +
        '   Run `npm run db:generate` manually if you changed the schema.',
    )
    return 0
  }

  const created = [...sqlNames(outDir)].filter((f) => !before.has(f))
  if (created.length === 0) {
    console.log('✓ no migration drift (schema matches the latest snapshot)')
    return 0
  }

  console.error(
    '\n❌ Schema drift: the Drizzle schema has changes with no generated migration.\n' +
      '   Run `npm run db:generate` (in packages/db) and commit the migration.\n' +
      '   Pending changes drizzle would generate:\n',
  )
  for (const f of created) {
    console.error(`--- ${f} ---`)
    console.error(readFileSync(join(outDir, f), 'utf8').trim())
  }
  console.error('')
  return 1
}

try {
  process.exitCode = main()
} catch (err) {
  // Our own harness failed (couldn't copy, missing bin, etc.) — fail-open.
  console.warn(`⚠️  migration-drift check skipped (${err?.message || err}) — allowing push.`)
  process.exitCode = 0
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
