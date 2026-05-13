import type Database from 'better-sqlite3'

/**
 * Adds nullable cache-token columns to `agent_runs` so the /dev/agent-runs
 * dashboard + cost-estimate math can reflect Anthropic prompt-caching usage.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  After the cost-controls PR, agent-loop accumulates two new      │
 *   │  values from response.usage on every iteration:                  │
 *   │                                                                   │
 *   │   • cache_read_input_tokens   — tokens served from cache         │
 *   │                                  (billed at 0.1× input rate)     │
 *   │   • cache_creation_input_tokens — tokens written to cache         │
 *   │                                    (billed at 1.25× input rate)  │
 *   │                                                                   │
 *   │  Pre-PR runs have NULL in both columns; rowToStored coerces NULL  │
 *   │  to 0. agent_runs.cost_estimate_usd math: (input × 1.0 + read ×  │
 *   │  0.1 + create × 1.25 + output × output_rate) / 1e6.              │
 *   │                                                                   │
 *   │  Idempotency: ALTER TABLE ADD COLUMN fails on duplicate column,  │
 *   │  so we check PRAGMA table_info first.                             │
 *   └──────────────────────────────────────────────────────────────────┘
 */
function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === columnName)
}

export function runAgentRunsCacheTokensMigration(db: Database.Database): void {
  if (!columnExists(db, 'agent_runs', 'cache_read_input_tokens_total')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN cache_read_input_tokens_total INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columnExists(db, 'agent_runs', 'cache_creation_input_tokens_total')) {
    db.exec(`ALTER TABLE agent_runs ADD COLUMN cache_creation_input_tokens_total INTEGER NOT NULL DEFAULT 0`)
  }
}
