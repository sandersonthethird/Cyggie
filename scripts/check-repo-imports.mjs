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
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// Directories to scan. Web has its own ESLint setup; mobile doesn't talk to
// SQLite repos. Tests are explicitly excluded.
//
// packages/services/src IS scanned (Phase 2, 2026-06-17). The original
// 2026-05-22 audit found ~30 pre-existing direct repo imports across
// packages/services/* and deferred the scan. Phase 2 closed that gap: the
// WRITERS among them (stub-enrichment + partner-meeting-reconcile updateCompany,
// meeting-summary-recovery updateMeeting) were migrated to the barrel; the rest
// are read-only context builders / summary readers (see NAMESPACE_READONLY_*).
const SCAN_DIRS = ['src', 'packages/db/src/sqlite/repositories', 'packages/services/src']
const SKIP_PATH_PARTS = [
  'node_modules',
  '__tests__',
  '/tests/',
  '.test.ts',
  '.spec.ts',
  // The repos themselves import each other directly — that's fine.
  'packages/db/src/sqlite/repositories',
]

// Repos wrapped by the barrel. A WRITE function imported from any of these
// `*.repo.ts` files bypasses the outbox. Repos outside this list (audit,
// settings, search, deal, etc.) are not yet sync-wrapped and import directly.
const WRAPPED_REPOS = ['meeting', 'contact', 'org-company', 'notes', 'task']
const wrappedPattern = WRAPPED_REPOS.map((r) => r.replace(/-/g, '\\-')).join('|')

// Match an import statement from a wrapped repo, capturing the import CLAUSE so
// we can tell a namespace import (`* as fooRepo`) from a named one (`{ a, b }`).
//   group 1 → namespace binding (e.g. "* as meetingRepo"), or undefined
//   group 2 → named list (e.g. "getCompany, updateCompany"), or undefined
//   group 3 → repo name
const IMPORT_PATTERN = new RegExp(
  `import\\s+(?:(\\*\\s+as\\s+\\w+)|\\{([^}]*)\\})\\s+from\\s+['"](?:[^'"]*\\/)?(${wrappedPattern})\\.repo(?:\\.ts)?['"]`,
  'g',
)

// notes-base.ts exports the `makeEntityNotesRepo` factory, which returns an
// entity-notes repo whose create/update/delete are UNWRAPPED (write straight to
// SQLite, bypassing the outbox). It doesn't match the `*.repo.ts` pattern above.
// Production WRITERS must use `makeSyncedEntityNotesRepo` from the barrel.
//
// We can't statically prove a given importer only READS (the repo is often
// aliased through a `repo` param before a `.create()` call — see
// note-companion-backfill), so — exactly like NAMESPACE_READONLY_ALLOWLIST below
// — we flag EVERY raw-factory import and exempt a hand-audited read-only set.
// If you add a WRITE via the raw factory, route it through the barrel; do NOT
// widen this list. Type-only imports (`import type { EntityNotesRepo }`) carry
// no write capability and never match.
const NOTES_BASE_FACTORY_IMPORT =
  /import\s+\{[^}]*\bmakeEntityNotesRepo\b[^}]*\}\s+from\s+['"][^'"]*notes-base['"]/

// Hand-audited READ-ONLY users of the raw factory (only `.list`/`.get`/
// `.listForEntities`). Context builders + summary readers; verified to call no
// write method on the repo.
const NOTES_BASE_READONLY_ALLOWLIST = new Set(
  [
    'src/main/ipc/chat.ipc.ts',
    'src/main/ipc/investment-memo.ipc.ts',
    'packages/services/src/company-summary-sync.service.ts',
    'packages/services/src/llm/agents/memo-producer-agent.ts',
    'packages/services/src/llm/agents/thesis-tools.ts',
    'packages/services/src/llm/company-key-takeaways.ts',
    'packages/services/src/llm/contact-context-builder.ts',
    'packages/services/src/llm/context-builders.ts',
    'packages/services/src/llm/entities-chat.ts',
    'packages/services/src/llm/memo-context-gatherer.ts',
    'packages/services/src/partner-meeting-reconcile.service.ts',
  ].map((p) => p.replaceAll('/', sep)),
)

// A named import of a function whose name starts with one of these prefixes is
// a WRITE — it MUST go through the barrel so the write reaches the outbox.
// Read functions (get*/list*/resolve*/count*/find*/exists*/parse*/has*) never
// match, so a raw read import is allowed (the barrel only matters for writes).
const WRITER_PREFIX =
  /^(create|update|delete|upsert|set|merge|tag|add|link|unlink|remove|getOrCreate|bulk|flag|unflag|refresh|reorder|rename|archive|pin|unpin)/

// Files allowed to NAMESPACE-import (`import * as fooRepo`) a wrapped repo. A
// namespace import hides which members are used, so the guard can't prove
// read-only — these were HAND-AUDITED as read-only (LLM context builders,
// company/contact summary readers). If you add a WRITE call (fooRepo.updateX,
// createX, …) in one of these, route that write through the barrel instead —
// do NOT widen this list to cover a new write.
const NAMESPACE_READONLY_ALLOWLIST = new Set(
  [
    'packages/services/src/contact-summary-sync.service.ts',
    'packages/services/src/company-summary-sync.service.ts',
    'packages/services/src/llm/contact-context-builder.ts',
    'packages/services/src/llm/chat.ts',
    'packages/services/src/llm/memo-context-gatherer.ts',
    'packages/services/src/llm/company-key-takeaways.ts',
    'packages/services/src/llm/context-builders.ts',
    'packages/services/src/llm/entities-chat.ts',
    'packages/services/src/llm/company-chat.ts',
    'packages/services/src/llm/agents/thesis-tools.ts',
    'packages/services/src/llm/agents/memo-producer-tools.ts',
    'packages/services/src/llm/agents/memo-producer-agent.ts',
  ].map((p) => p.replaceAll('/', sep)),
)

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
      if (
        NOTES_BASE_FACTORY_IMPORT.test(content) &&
        !NOTES_BASE_READONLY_ALLOWLIST.has(rel)
      ) {
        violations.push({
          file: rel,
          importPath: 'notes-base',
          detail:
            'raw makeEntityNotesRepo — use makeSyncedEntityNotesRepo from the barrel (or add to NOTES_BASE_READONLY_ALLOWLIST if read-only)',
        })
      }
      for (const match of content.matchAll(IMPORT_PATTERN)) {
        const [, namespaceClause, namedList, repo] = match
        if (namespaceClause) {
          // Namespace import — can't see the call sites. Allowed only for
          // hand-audited read-only files; otherwise it's a potential bypass.
          if (!NAMESPACE_READONLY_ALLOWLIST.has(rel)) {
            violations.push({ file: rel, importPath: `${repo}.repo`, detail: `namespace import (${namespaceClause.trim()})` })
          }
          continue
        }
        if (namedList) {
          const writers = namedList
            .split(',')
            .map((n) => n.trim().split(/\s+as\s+/)[0].trim()) // strip `as alias`
            .filter((n) => n && WRITER_PREFIX.test(n))
          for (const w of writers) {
            violations.push({ file: rel, importPath: `${repo}.repo`, detail: `write fn '${w}'` })
          }
        }
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
  console.error(`  ${v.file}  →  '${v.importPath}'  (${v.detail})`)
}
console.error('')
console.error('Production code must import from @cyggie/db/sqlite/repositories')
console.error('(the sync-wrapped barrel) so writes flow through the outbox.')
console.error('Tests under __tests__/ may import raw repos for un-wrapped testing.')
process.exit(1)
