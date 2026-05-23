import type Database from 'better-sqlite3'

/**
 * Adds `lamport TEXT NOT NULL DEFAULT '0'` to investment_memos and
 * investment_memo_versions so they can join the Phase 1.5a sync engine.
 *
 * Migration 096 added lamport to the original 18 OWNED_TABLES. Memos were
 * explicitly out-of-scope at that point (per the owned-tables.ts header
 * comment: "Non-V1 tables (custom_fields, decision_logs, partner_meeting_
 * digests, deals, memos, etc.) — pulled in as those domains land in
 * mobile."). The mobile Memos-on-company tab (commit 6bc74da) is that
 * trigger — memos written on desktop must reach Neon so the gateway's
 * GET /memos route can return them.
 *
 * Both tables are also added to OWNED_TABLES in the same change set;
 * see packages/db/src/sync/owned-tables.ts.
 *
 * Idempotent via PRAGMA table_info check.
 */
export function runMemoSyncLamportMigration(db: Database.Database): void {
  for (const table of ['investment_memos', 'investment_memo_versions']) {
    const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as {
      name: string
    }[]
    if (cols.some((c) => c.name === 'lamport')) continue
    db.exec(`ALTER TABLE ${table} ADD COLUMN lamport TEXT NOT NULL DEFAULT '0'`)
  }
}
