import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMemoEvidenceMigration } from '@cyggie/db/sqlite/migrations/085-memo-evidence'
import { runAgentRunsMigration } from '@cyggie/db/sqlite/migrations/086-agent-runs'
import { runAgentRunEventsMigration } from '@cyggie/db/sqlite/migrations/087-agent-run-events'

/**
 * Migrations 085–087 add the agent-feature schema:
 *   memo_evidence       → sidecar evidence rows for memo claims
 *   agent_runs          → persistent run records (cost, status, tokens)
 *   agent_run_events    → compressed event trace per run
 *
 * Tests cover: table creation, idempotence, indexes, FK behavior,
 * UNIQUE constraint semantics (NULL distinctness for web sources),
 * and partial-index existence for orphan-GC queries.
 */

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Prerequisite: investment_memo_versions exists (085 + 086 FK reference it)
  db.exec(`
    CREATE TABLE investment_memo_versions (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown)
      VALUES ('v-1', 'memo-1', 1, '# Test memo');
  `)
  return db
}

describe('migration 085 — memo_evidence', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb(); runMemoEvidenceMigration(db) })

  it('creates the table', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memo_evidence'`).get()
    expect(row).toBeTruthy()
  })

  it('is idempotent', () => {
    expect(() => { runMemoEvidenceMigration(db); runMemoEvidenceMigration(db) }).not.toThrow()
  })

  it('creates both indexes', () => {
    const versionIdx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memo_evidence_version'`).get()
    const sourceIdx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memo_evidence_source'`).get()
    expect(versionIdx).toBeTruthy()
    expect(sourceIdx).toBeTruthy()
  })

  it('accepts an internal-source row', () => {
    expect(() => {
      db.prepare(`INSERT INTO memo_evidence (id, version_id, claim_text, claim_category, source_type, source_id, snippet, confidence)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('e1', 'v-1', 'Series A momentum', 'traction', 'meeting', 'meeting-42', 'closed Q3 with 220% NRR', 'high')
    }).not.toThrow()
  })

  it('accepts a web-source row with NULL source_id', () => {
    expect(() => {
      db.prepare(`INSERT INTO memo_evidence (id, version_id, claim_text, source_type, source_url, snippet, confidence)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('e2', 'v-1', 'TAM is $14B', 'web', 'https://example.com/report', '"the global market reached $14B in 2025"', 'medium')
    }).not.toThrow()
  })

  it('allows multiple web rows for same claim with distinct URLs', () => {
    const stmt = db.prepare(`INSERT INTO memo_evidence (id, version_id, claim_text, source_type, source_url, snippet, confidence)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    stmt.run('e3', 'v-1', 'TAM is $14B', 'web', 'https://a.com', 'snippet a', 'high')
    expect(() => stmt.run('e4', 'v-1', 'TAM is $14B', 'web', 'https://b.com', 'snippet b', 'medium')).not.toThrow()
  })

  it('dedupes internal-source rows on (version_id, claim_text, source_type, source_id) via partial unique index', () => {
    const stmt = db.prepare(`INSERT INTO memo_evidence (id, version_id, claim_text, source_type, source_id, snippet, confidence)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    stmt.run('e5', 'v-1', 'claim', 'meeting', 'm-1', 's', 'high')
    expect(() => stmt.run('e6', 'v-1', 'claim', 'meeting', 'm-1', 's2', 'low')).toThrow(/UNIQUE/)
  })

  it('dedupes web-source rows on (version_id, claim_text, source_url) via partial unique index', () => {
    const stmt = db.prepare(`INSERT INTO memo_evidence (id, version_id, claim_text, source_type, source_url, snippet, confidence)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
    stmt.run('e7', 'v-1', 'claim', 'web', 'https://x.com', 's', 'high')
    expect(() => stmt.run('e8', 'v-1', 'claim', 'web', 'https://x.com', 's2', 'low')).toThrow(/UNIQUE/)
  })

  it('cascades delete when memo version is deleted', () => {
    db.prepare(`INSERT INTO memo_evidence (id, version_id, claim_text, source_type, snippet, confidence)
                VALUES ('e7', 'v-1', 'c', 'note', 's', 'high')`).run()
    db.prepare(`DELETE FROM investment_memo_versions WHERE id = 'v-1'`).run()
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM memo_evidence`).get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})

describe('migration 086 — agent_runs', () => {
  let db: Database.Database
  beforeEach(() => { db = makeDb(); runAgentRunsMigration(db) })

  it('creates the table', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_runs'`).get()
    expect(row).toBeTruthy()
  })

  it('is idempotent', () => {
    expect(() => { runAgentRunsMigration(db); runAgentRunsMigration(db) }).not.toThrow()
  })

  it('creates the company-time index', () => {
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_runs_company'`).get()
    expect(idx).toBeTruthy()
  })

  it('creates the partial running-status index for orphan-GC', () => {
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_agent_runs_running'`).get() as { sql: string } | undefined
    expect(idx).toBeTruthy()
    expect(idx!.sql).toMatch(/WHERE\s+status='running'/i)
  })

  it('accepts a complete run row', () => {
    expect(() => {
      db.prepare(`INSERT INTO agent_runs (id, kind, company_id, user_id, mode, status, iterations, input_tokens_total,
                                          output_tokens_total, cost_estimate_usd, tool_call_count, web_search_count,
                                          result_version_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('r1', 'thesis_stress_test', 'co-1', 'u-1', 'stress_test', 'success', 11, 287000, 18000, 1.18, 14, 4, 'v-1')
    }).not.toThrow()
  })

  it('SET NULLs result_version_id when memo version is deleted', () => {
    db.prepare(`INSERT INTO agent_runs (id, kind, company_id, user_id, status, result_version_id)
                VALUES ('r2', 'thesis_stress_test', 'co-1', 'u-1', 'success', 'v-1')`).run()
    db.prepare(`DELETE FROM investment_memo_versions WHERE id = 'v-1'`).run()
    const row = db.prepare(`SELECT result_version_id FROM agent_runs WHERE id = 'r2'`).get() as { result_version_id: string | null }
    expect(row.result_version_id).toBeNull()
  })
})

describe('migration 087 — agent_run_events', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    runAgentRunsMigration(db) // FK target
    runAgentRunEventsMigration(db)
    db.prepare(`INSERT INTO agent_runs (id, kind, company_id, user_id, status) VALUES ('r1', 'thesis_stress_test', 'co-1', 'u-1', 'running')`).run()
  })

  it('creates the table', () => {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='agent_run_events'`).get()
    expect(row).toBeTruthy()
  })

  it('is idempotent', () => {
    expect(() => { runAgentRunEventsMigration(db); runAgentRunEventsMigration(db) }).not.toThrow()
  })

  it('creates the run_id+ts index', () => {
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_run_events_run'`).get()
    expect(idx).toBeTruthy()
  })

  it('appends events with auto-incrementing id (preserves insert order on same ts)', () => {
    const stmt = db.prepare(`INSERT INTO agent_run_events (run_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)`)
    stmt.run('r1', '2026-05-08T10:00:00', 'tool_call', '{}')
    stmt.run('r1', '2026-05-08T10:00:00', 'tool_result_summary', '{}')
    const rows = db.prepare(`SELECT id, event_type FROM agent_run_events WHERE run_id = 'r1' ORDER BY id`).all() as Array<{ id: number; event_type: string }>
    expect(rows.map(r => r.event_type)).toEqual(['tool_call', 'tool_result_summary'])
    expect(rows[1].id).toBeGreaterThan(rows[0].id)
  })

  it('cascades delete when agent run is deleted', () => {
    db.prepare(`INSERT INTO agent_run_events (run_id, event_type, payload_json) VALUES ('r1', 'thinking', '{}')`).run()
    db.prepare(`DELETE FROM agent_runs WHERE id = 'r1'`).run()
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM agent_run_events`).get() as { n: number }
    expect(remaining.n).toBe(0)
  })
})
