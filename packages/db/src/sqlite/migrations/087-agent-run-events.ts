import type Database from 'better-sqlite3'

/**
 * Compressed event trace for each agent run. One row per AgentEvent emitted
 * by the agent loop (tool_call, tool_result_summary, thinking, error, cap,
 * final_text_chunk, etc.). `payload_json` is the serialized AgentEvent.
 *
 * Powers the /dev/agent-runs trace expand panel — click a run row, see the
 * tool-by-tool play-by-play.
 *
 * Writes are buffered per turn in the agent loop (not per event) to avoid
 * sync-write contention during a hot tool-use loop. Flushed on every turn
 * boundary and on run completion.
 *
 * Auto-incrementing INTEGER id keeps insert order even if multiple events
 * share the same `ts` (millisecond resolution can collide).
 */
export function runAgentRunEventsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_run_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      ts           TEXT NOT NULL DEFAULT (datetime('now')),
      event_type   TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_run_events_run ON agent_run_events(run_id, ts);
  `)
}
