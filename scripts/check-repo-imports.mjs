#!/usr/bin/env node
// =============================================================================
// check-repo-imports.mjs — guards the sync-wrapping barrel from bypass.
//
// Production code MUST import owned-table repository functions from the
// barrel:
//   import { updateNote } from '@cyggie/db/sqlite/repositories'
//
// Direct imports from individual `*.repo.ts` files bypass the writeWithSync
// wrapper and would silently desync rows to the Postgres outbox. This script
// catches that mistake by grepping the desktop source for offending imports.
//
// Test files are allowed to import raw repos so their tests can target
// the un-wrapped functions without triggering outbox writes.
//
// Run: `node scripts/check-repo-imports.mjs` — exits 1 with a list of
// violations, 0 if clean. Add to CI before vitest.
// =============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Directories to scan. Web has its own ESLint setup; mobile doesn't talk to
// SQLite repos. Tests are explicitly excluded.
const SCAN_DIRS = ['src', 'packages/db/src/sqlite/repositories']
const SKIP_PATH_PARTS = [
  'node_modules',
  '__tests__',
  '/tests/',
  '.test.ts',
  '.spec.ts',
  // The repos themselves import each other directly — that's fine.
  'packages/db/src/sqlite/repositories',
]

const IMPORT_PATTERN = /from\s+['"](?:[^'"]*\/)?([\w-]+\.repo)(?:\.ts)?['"]/g

const violations = []

function walk(dir) {
  const entries = readdirSync(dir)
  for (const name of entries) {
    const full = join(dir, name)
    const rel = relative(REPO_ROOT, full)
    if (SKIP_PATH_PARTS.some((p) => rel.includes(p))) continue
    const s = statSync(full)
    if (s.isDirectory()) {
      walk(full)
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      const content = readFileSync(full, 'utf8')
      for (const match of content.matchAll(IMPORT_PATTERN)) {
        violations.push({ file: rel, importPath: match[1] })
      }
    }
  }
}

for (const d of SCAN_DIRS) {
  try {
    walk(join(REPO_ROOT, d))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}

if (violations.length === 0) {
  console.log('[check-repo-imports] clean — all production code imports through the barrel ✓')
  process.exit(0)
}

console.error('[check-repo-imports] ✗ direct repo imports detected:')
for (const v of violations) {
  console.error(`  ${v.file}  →  imports from '${v.importPath}'`)
}
console.error('')
console.error('Production code must import from @cyggie/db/sqlite/repositories')
console.error('(the sync-wrapped barrel) so writes flow through the outbox.')
console.error('Tests under __tests__/ may import raw repos for un-wrapped testing.')
process.exit(1)
