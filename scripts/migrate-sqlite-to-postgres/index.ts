// =============================================================================
// One-time SQLite → Postgres data migration tool (Phase 0.3 of the mobile V1 plan).
//
// Reads from the desktop's ~/Documents/MeetingIntelligence/echovault.db,
// transforms each row per the consolidated schema in @cyggie/db, writes to Neon
// via drizzle. Restartable via per-table checkpoints in migration_progress.
//
//   USAGE
//   ─────
//   GATEWAY_DATABASE_URL=... \
//   node --env-file=.env.local --experimental-strip-types \
//        scripts/migrate-sqlite-to-postgres/index.ts \
//        --sqlite=$HOME/Documents/MeetingIntelligence/echovault.db \
//        --user-id=<users.id from Neon>
//
//   FLOW
//   ────
//     1. Connect to SQLite (read-only) + Postgres (via pg pool).
//     2. Verify --user-id exists in Neon's users table.
//     3. For each table in DEPENDENCY ORDER:
//        a. Look up migration_progress.status. Skip if 'completed'.
//        b. Stream rows from SQLite in batches.
//        c. Transform each row (timestamps, booleans, JSON, user_id stamping).
//        d. Bulk INSERT … ON CONFLICT (id) DO NOTHING for idempotency.
//        e. Update migration_progress incrementally.
//        f. On completion: verify row count vs source, mark 'completed'.
//     4. Print final report.
//
//   IDEMPOTENCY
//   ───────────
//   Every migrator uses INSERT … ON CONFLICT (primary_key) DO NOTHING. Re-running
//   the script picks up partially-completed tables and only inserts missing rows.
//
//   ASSIGNING USER_ID
//   ─────────────────
//   V1 is single-tenant — every row in SQLite belongs to the one user. The
//   --user-id arg is stamped onto every owned-row insert. (In multi-tenant V2,
//   the SQLite source would need a user_id column to dispatch rows correctly.)
// =============================================================================

import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const { Pool } = pg

// -- args ---------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    sqlite: { type: 'string' },
    'user-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    table: { type: 'string' }, // optional — migrate just one table
    'batch-size': { type: 'string', default: '500' },
  },
})

if (!values.sqlite) throw new Error('--sqlite=<path-to-echovault.db> required')
if (!values['user-id']) throw new Error('--user-id=<users.id from Neon> required')
if (!process.env['GATEWAY_DATABASE_URL']) {
  throw new Error('GATEWAY_DATABASE_URL env var required (use --env-file=.env.local)')
}

const USER_ID = values['user-id']
const SQLITE_PATH = values.sqlite
const DRY_RUN = values['dry-run']
const ONLY_TABLE = values.table
const BATCH_SIZE = Number(values['batch-size'])

// -- connections --------------------------------------------------------------

const sqlite = new DatabaseSync(SQLITE_PATH, { open: true, readOnly: true })
const pgPool = new Pool({
  connectionString: process.env['GATEWAY_DATABASE_URL'],
  max: 4,
})

// -- checkpoint helpers -------------------------------------------------------

interface CheckpointRow {
  sourceTable: string
  targetTable: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  rowsMigrated: number
  rowsExpected: number | null
  errorMessage: string | null
}

async function loadCheckpoint(sourceTable: string): Promise<CheckpointRow | null> {
  const res = await pgPool.query(
    `SELECT source_table, target_table, status, rows_migrated, rows_expected, error_message
     FROM migration_progress WHERE source_table = $1`,
    [sourceTable],
  )
  if (res.rowCount === 0) return null
  const r = res.rows[0]
  return {
    sourceTable: r.source_table,
    targetTable: r.target_table,
    status: r.status,
    rowsMigrated: Number(r.rows_migrated),
    rowsExpected: r.rows_expected == null ? null : Number(r.rows_expected),
    errorMessage: r.error_message,
  }
}

async function upsertCheckpoint(cp: Omit<CheckpointRow, 'errorMessage'> & { errorMessage?: string | null }) {
  await pgPool.query(
    `INSERT INTO migration_progress (
       source_table, target_table, status, rows_migrated, rows_expected, error_message,
       started_at, completed_at
     ) VALUES ($1,$2,$3::varchar,$4,$5,$6,
       CASE WHEN $3::varchar IN ('in_progress','completed') THEN now() ELSE NULL END,
       CASE WHEN $3::varchar = 'completed' THEN now() ELSE NULL END
     )
     ON CONFLICT (source_table) DO UPDATE SET
       status = EXCLUDED.status,
       rows_migrated = EXCLUDED.rows_migrated,
       rows_expected = EXCLUDED.rows_expected,
       error_message = EXCLUDED.error_message,
       started_at = COALESCE(migration_progress.started_at, EXCLUDED.started_at),
       completed_at = EXCLUDED.completed_at`,
    [
      cp.sourceTable,
      cp.targetTable,
      cp.status,
      cp.rowsMigrated.toString(),
      cp.rowsExpected?.toString() ?? null,
      cp.errorMessage ?? null,
    ],
  )
}

// -- migrator type ------------------------------------------------------------

/**
 * A migrator describes how one SQLite source table maps to one (or more) Postgres
 * target tables. `select` returns the row stream from SQLite; `insertSql` is the
 * parameterized Postgres INSERT with ON CONFLICT DO NOTHING. `transform` maps a
 * SQLite row to the parameter array for `insertSql`.
 */
export interface Migrator {
  sourceTable: string
  targetTable: string
  // SQL to count expected rows in SQLite (for verification).
  countSql: string
  // SQL to read source rows (pagination handled by caller via LIMIT/OFFSET or ROWID).
  selectSql: string
  // Postgres INSERT … ON CONFLICT … DO NOTHING. Use $1, $2, … placeholders.
  insertSql: string
  // Transform a SQLite row to the parameter array for insertSql.
  // Return null to SKIP this row (useful for invalid data).
  transform: (sqliteRow: Record<string, unknown>) => unknown[] | null
}

// -- orchestrator -------------------------------------------------------------

async function migrate(m: Migrator): Promise<void> {
  console.log(`\n[${m.sourceTable}] → [${m.targetTable}]`)

  const expected = (sqlite.prepare(m.countSql).get() as { c: number }).c
  console.log(`  source rows: ${expected}`)

  if (expected === 0) {
    await upsertCheckpoint({
      sourceTable: m.sourceTable,
      targetTable: m.targetTable,
      status: 'completed',
      rowsMigrated: 0,
      rowsExpected: 0,
    })
    console.log(`  (empty source — marked complete)`)
    return
  }

  const cp = await loadCheckpoint(m.sourceTable)
  if (cp?.status === 'completed') {
    console.log(`  ✓ already completed (${cp.rowsMigrated} rows)`)
    return
  }

  await upsertCheckpoint({
    sourceTable: m.sourceTable,
    targetTable: m.targetTable,
    status: 'in_progress',
    rowsMigrated: cp?.rowsMigrated ?? 0,
    rowsExpected: expected,
  })

  if (DRY_RUN) {
    // Just count + transform a sample row to validate transform logic.
    const sample = sqlite.prepare(m.selectSql + ' LIMIT 1').get() as Record<string, unknown> | undefined
    if (sample) {
      const transformed = m.transform(sample)
      console.log(`  dry-run sample (${transformed?.length ?? 0} params):`, JSON.stringify(transformed).slice(0, 200))
    }
    return
  }

  // Stream + insert in batches.
  const stmt = sqlite.prepare(m.selectSql)
  let migrated = 0
  let skipped = 0
  const batch: unknown[][] = []

  for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
    const params = m.transform(row)
    if (params == null) {
      skipped++
      continue
    }
    batch.push(params)
    if (batch.length >= BATCH_SIZE) {
      migrated += await flushBatch(m.insertSql, batch)
      batch.length = 0
      await upsertCheckpoint({
        sourceTable: m.sourceTable,
        targetTable: m.targetTable,
        status: 'in_progress',
        rowsMigrated: migrated,
        rowsExpected: expected,
      })
      process.stdout.write(`  ${migrated}/${expected}\r`)
    }
  }
  if (batch.length > 0) {
    migrated += await flushBatch(m.insertSql, batch)
  }

  // Final verification: query the actual Postgres row count. `migrated` only counts
  // INSERTs from this run — ON CONFLICT DO NOTHING returns 0 rowCount for rows that
  // already existed from a previous partial run. The real signal is whether the
  // target table now has at least as many rows as the source.
  const actualRes = await pgPool.query(`SELECT count(*)::int AS c FROM ${m.targetTable}`)
  const actualCount = actualRes.rows[0].c

  await upsertCheckpoint({
    sourceTable: m.sourceTable,
    targetTable: m.targetTable,
    status: 'completed',
    rowsMigrated: actualCount,
    rowsExpected: expected,
  })
  const inserted = migrated
  const reused = actualCount - inserted
  console.log(
    `  ✓ ${actualCount} rows in ${m.targetTable}` +
      (inserted > 0 ? ` (+${inserted} this run` : '') +
      (reused > 0 ? `, ${reused} preserved from prior runs)` : inserted > 0 ? ')' : '') +
      (skipped > 0 ? ` — ${skipped} source rows skipped by transform` : ''),
  )
}

async function flushBatch(insertSql: string, batch: unknown[][]): Promise<number> {
  // Naive per-row execution — clear and correct. Bulk INSERT optimization deferred
  // until profiling shows it matters; this script runs once and is I/O-bound on
  // Neon RTT anyway. Could switch to multi-VALUES inserts or pg-copy if needed.
  let inserted = 0
  const client = await pgPool.connect()
  try {
    await client.query('BEGIN')
    for (const params of batch) {
      const res = await client.query(insertSql, params)
      inserted += res.rowCount ?? 0
    }
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  return inserted
}

// -- main ---------------------------------------------------------------------

async function main() {
  console.log('Cyggie SQLite → Postgres migration')
  console.log(`  source: ${SQLITE_PATH}`)
  console.log(`  target: ${process.env['GATEWAY_DATABASE_URL']?.replace(/:[^@]+@/, ':<masked>@')}`)
  console.log(`  user_id: ${USER_ID}`)
  console.log(`  dry_run: ${DRY_RUN}`)
  console.log(`  batch_size: ${BATCH_SIZE}`)

  // Verify user exists
  const userRes = await pgPool.query(`SELECT id, email FROM users WHERE id = $1`, [USER_ID])
  if (userRes.rowCount === 0) {
    throw new Error(
      `User ${USER_ID} not found in Neon users table. Run OAuth signup first, then re-run with the assigned id.`,
    )
  }
  console.log(`  user: ${userRes.rows[0].email}\n`)

  // Load migrators (kept in a dynamic import to keep this file small).
  const { allMigrators } = await import('./migrators.ts')
  const migrators = ONLY_TABLE
    ? allMigrators(USER_ID).filter((m) => m.sourceTable === ONLY_TABLE)
    : allMigrators(USER_ID)

  if (migrators.length === 0) {
    throw new Error(ONLY_TABLE ? `No migrator for table '${ONLY_TABLE}'` : 'No migrators registered')
  }

  for (const m of migrators) {
    try {
      await migrate(m)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\n  ✗ failed: ${msg}`)
      await upsertCheckpoint({
        sourceTable: m.sourceTable,
        targetTable: m.targetTable,
        status: 'failed',
        rowsMigrated: 0,
        rowsExpected: null,
        errorMessage: msg,
      })
      // Don't abort on individual failure — record and continue. Final report
      // shows the failed tables for manual inspection.
    }
  }

  // Final report
  console.log('\n=== FINAL REPORT ===')
  const report = await pgPool.query(
    `SELECT source_table, target_table, status, rows_migrated, rows_expected, error_message
     FROM migration_progress ORDER BY source_table`,
  )
  for (const r of report.rows) {
    const icon = r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '…'
    const mismatch =
      r.status === 'completed' && r.rows_expected != null && r.rows_migrated !== r.rows_expected ? ' MISMATCH' : ''
    console.log(
      `  ${icon} ${r.source_table.padEnd(34)} ${r.rows_migrated}/${r.rows_expected ?? '?'}${mismatch}${
        r.error_message ? '  — ' + r.error_message : ''
      }`,
    )
  }

  sqlite.close()
  await pgPool.end()
}

main().catch((err) => {
  console.error('fatal:', err)
  sqlite.close()
  pgPool.end().finally(() => process.exit(1))
})
