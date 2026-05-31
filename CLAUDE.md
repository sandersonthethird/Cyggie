# gstack

Use the `/browse` skill from gstack for all web browsing. Never use `mcp__claude-in-chrome__*` tools.

Available gstack skills:
- `/browse` — web browsing
- `/plan-ceo-review` — review a plan from a CEO perspective
- `/plan-eng-review` — review a plan from an engineering perspective
- `/review` — code review
- `/ship` — ship a change
- `/retro` — run a retrospective

# Sync — repository barrel pattern

The desktop SyncAgent (Phase 1.5a) propagates every owned-row write from
SQLite to Neon Postgres via an outbox. To guarantee writes can't bypass the
outbox, production code must import owned-table repository functions from
the **barrel** at `@cyggie/db/sqlite/repositories`, not from individual
`*.repo.ts` files:

```ts
// ✓ Correct — sync-wrapped, writes flow through the outbox
import { updateNote } from '@cyggie/db/sqlite/repositories'

// ✗ Wrong — bypasses the wrapper; row never reaches Neon
import { updateNote } from '@cyggie/db/sqlite/repositories/notes.repo'
```

The barrel re-exports each `createX` / `updateX` / `deleteX` / `upsertX`
function wrapped in `withSync()` (which opens a transaction, runs the
original, and emits an outbox entry). Reads pass through unchanged.

Tests under `__tests__/` and `*.test.ts` files MAY import raw repos so they
can target un-wrapped functions without polluting the outbox. The CI script
`scripts/check-repo-imports.mjs` enforces this — it walks `src/` and
flags any production import of a `*.repo.ts` path. Run locally before
opening a PR:

```
node scripts/check-repo-imports.mjs
```

A second line of defense is a dev-mode runtime assertion inside each raw
write function: it throws if called outside an active sync transaction.
This catches bypasses the static check might miss (e.g. dynamic imports).
The assertion is compiled out of production builds.

# MCP — tool signatures are a public API contract

External MCP clients (Claude Desktop installs, the Cyggie Slack bot,
future Zapier/Cursor integrations) call into the gateway via the tools
registered in [`api-gateway/src/mcp/server.ts`](api-gateway/src/mcp/server.ts).
Each tool's **name**, **input schema**, and **error codes** are
contracts those external clients depend on.

```ts
// ✓ Safe — adding a new tool. Old clients ignore it; new ones use it.
server.registerTool('cyggie_get_deal', { ... }, async (input) => { ... })

// ✗ Breaking — renaming an existing tool. Every external install
//   stops working until reconfigured.
server.registerTool('cyggie_lookup_company', { ... }, ...)  // was cyggie_get_company

// ✗ Breaking — removing or renaming an input field on an existing tool.
inputSchema: { name: z.string() }  // was: { query: z.string() }

// ✓ Safe — adding an OPTIONAL new input field.
inputSchema: { query: z.string(), includeMeta: z.boolean().optional() }
```

Error codes (the stable enum in
[`api-gateway/src/shared/error-envelope.ts`](api-gateway/src/shared/error-envelope.ts))
are the same kind of contract. **Add** new codes when you need a new
failure category. **Don't rename** existing codes — clients branch on
the string. New codes are forward-compatible (clients that don't
recognize them fall back to the message).

Mirror the `withSync` discipline: when in doubt, add rather than mutate.
