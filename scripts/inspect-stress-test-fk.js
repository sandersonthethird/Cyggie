#!/usr/bin/env node
/**
 * One-shot diagnostic for the stress-test FK error.
 *
 * Reads the user's local SQLite DB (read-only) via the `sqlite3` CLI and
 * prints a digest covering every plausible FK culprit:
 *
 *   • stress_test_reports schema + FK list (verifies migration 093 ran)
 *   • audit_log schema + FK list
 *   • agent_runs schema + FK list
 *   • users table state
 *   • settings.currentUserId vs. actual users(id)
 *   • last 5 thesis_stress_test runs
 *
 * Uses the system `sqlite3` CLI instead of better-sqlite3 to avoid the
 * Electron-vs-Node ABI mismatch (better-sqlite3 is built for Electron's
 * embedded Node version, which doesn't match the system Node version).
 *
 * Run from repo root:
 *   node scripts/inspect-stress-test-fk.js
 */

const path = require('path')
const os = require('os')
const fs = require('fs')
const { execFileSync } = require('child_process')

// Match getDefaultStoragePath() in src/main/storage/paths.ts:
//   join(app.getPath('documents'), 'MeetingIntelligence')
const documentsDir = path.join(os.homedir(), 'Documents')
const dbPath = path.join(documentsDir, 'MeetingIntelligence', 'echovault.db')

if (!fs.existsSync(dbPath)) {
  console.error(`No DB found at: ${dbPath}`)
  console.error('If your storage path is custom, edit dbPath in this script.')
  process.exit(1)
}

/** Run a SQL query via sqlite3 CLI; returns stdout as string. */
function q(sql) {
  try {
    return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim()
  } catch (err) {
    return `ERR: ${err.message}`
  }
}

/** Run a SQL query and parse pipe-delimited rows; returns array of arrays. */
function qRows(sql) {
  const out = q(sql)
  if (!out || out.startsWith('ERR:')) return []
  return out.split('\n').filter(Boolean).map(r => r.split('|'))
}

function header(label) {
  console.log('')
  console.log('═'.repeat(70))
  console.log(label)
  console.log('═'.repeat(70))
}

function tableSchema(name) {
  header(`TABLE: ${name}`)
  const cols = qRows(`PRAGMA table_info(${name});`)
  if (cols.length === 0) {
    console.log(`  ⚠ Table does not exist (or query failed)`)
    return
  }
  console.log(`  Columns:`)
  for (const c of cols) {
    // cols: cid|name|type|notnull|dflt_value|pk
    const [, colName, colType, notnull, , pk] = c
    console.log(`    ${(colName ?? '').padEnd(28)} ${(colType ?? '').padEnd(10)} ${notnull === '1' ? 'NOT NULL' : ''} ${pk === '1' ? 'PRIMARY KEY' : ''}`)
  }
  const fks = qRows(`PRAGMA foreign_key_list(${name});`)
  if (fks.length === 0) {
    console.log(`  FKs: (none)`)
  } else {
    console.log(`  FKs:`)
    for (const fk of fks) {
      // fks: id|seq|table|from|to|on_update|on_delete|match
      const [, , refTable, from, to, onUpdate, onDelete] = fk
      console.log(`    ${from} → ${refTable}(${to})  on_delete=${onDelete} on_update=${onUpdate}`)
    }
  }
}

function showSetting(key) {
  const out = q(`SELECT value FROM settings WHERE key = '${key.replace(/'/g, "''")}';`)
  if (out.startsWith('ERR:')) return null
  return out || null
}

function rowExists(table, idCol, idValue) {
  const escaped = String(idValue).replace(/'/g, "''")
  const out = q(`SELECT 1 FROM ${table} WHERE ${idCol} = '${escaped}' LIMIT 1;`)
  if (out.startsWith('ERR:')) return `query error: ${out}`
  return out === '1'
}

// ─── Schema check ────────────────────────────────────────────────────────
tableSchema('stress_test_reports')
tableSchema('audit_log')
tableSchema('agent_runs')
tableSchema('agent_run_events')
tableSchema('users')

// ─── Users state ─────────────────────────────────────────────────────────
header('USERS TABLE')
const userCount = q(`SELECT COUNT(*) FROM users;`)
console.log(`  total rows: ${userCount}`)
const sampleUsers = qRows(`SELECT id, display_name, COALESCE(email, '(no email)') FROM users LIMIT 5;`)
for (const u of sampleUsers) {
  console.log(`    ${u[0]}  ${u[1]}  ${u[2]}`)
}

// ─── currentUserId vs users ──────────────────────────────────────────────
header('CURRENT USER (the smoking gun for audit_log FK)')
const currentUserId = showSetting('currentUserId')
const currentUserDisplayName = showSetting('currentUserDisplayName')
console.log(`  settings.currentUserId          = ${currentUserId ?? '(unset)'}`)
console.log(`  settings.currentUserDisplayName = ${currentUserDisplayName ?? '(unset)'}`)
if (currentUserId) {
  const exists = rowExists('users', 'id', currentUserId)
  if (exists === true) {
    console.log(`  ✓ users.id = ${currentUserId} EXISTS`)
  } else if (exists === false) {
    console.log(`  ✗ users.id = ${currentUserId} DOES NOT EXIST in users table`)
    console.log(`     → logAudit() with this user_id fires SQLITE_CONSTRAINT_FOREIGNKEY`)
    console.log(`     → THIS IS LIKELY THE ROOT CAUSE`)
  } else {
    console.log(`  ⚠ probe error: ${exists}`)
  }
}

// ─── Recent stress-test runs ─────────────────────────────────────────────
header('RECENT thesis_stress_test agent_runs (last 5)')
const recentRuns = qRows(`
  SELECT id, user_id, company_id, status,
         COALESCE(started_at, '-'), COALESCE(ended_at, '-'),
         COALESCE(error_class, ''), COALESCE(error_message, '')
    FROM agent_runs
   WHERE kind = 'thesis_stress_test'
   ORDER BY datetime(started_at) DESC
   LIMIT 5;
`.replace(/\s+/g, ' ').trim())
if (recentRuns.length === 0) {
  console.log(`  (no stress-test runs found)`)
} else {
  for (const r of recentRuns) {
    const [id, userId, companyId, status, startedAt, endedAt, errorClass, errorMessage] = r
    console.log(`  run ${(id ?? '').slice(0, 8)}  ${(status ?? '').padEnd(12)} u=${userId} c=${companyId}`)
    console.log(`    started: ${startedAt}  ended: ${endedAt}`)
    if (errorClass) console.log(`    error:   ${errorClass}: ${errorMessage ?? ''}`)
    const userOK = rowExists('users', 'id', userId)
    const companyOK = rowExists('companies', 'id', companyId)
    console.log(`    user_id valid: ${userOK === true ? '✓' : '✗ ' + userOK}`)
    console.log(`    company_id valid: ${companyOK === true ? '✓' : '✗ ' + companyOK}`)
  }
}

// ─── Migration check ─────────────────────────────────────────────────────
header('MIGRATION CHECK')
const stressFks = qRows(`PRAGMA foreign_key_list(stress_test_reports);`)
if (stressFks.length === 0) {
  console.log(`  ✓ migration 093 applied: stress_test_reports has NO foreign keys`)
} else {
  console.log(`  ✗ migration 093 NOT applied yet: stress_test_reports still has ${stressFks.length} FK(s)`)
  console.log(`     → Restart the Electron app (electron-vite dev needs a full restart`)
  console.log(`        to re-run migrations on app launch)`)
}

// ─── Existing stress_test_reports ────────────────────────────────────────
header('PERSISTED stress_test_reports (any?)')
const reportCount = q(`SELECT COUNT(*) FROM stress_test_reports;`)
console.log(`  total rows: ${reportCount}`)
if (Number(reportCount) > 0) {
  const sample = qRows(`SELECT id, memo_id, run_id, recommendation, created_at FROM stress_test_reports ORDER BY datetime(created_at) DESC LIMIT 3;`)
  for (const r of sample) {
    console.log(`    ${r[0]}  memo=${r[1]}  run=${r[2]}  rec=${r[3]}  ${r[4]}`)
  }
}

console.log('')
console.log('═'.repeat(70))
console.log('DONE. Look above for ✗ markers — those identify the FK culprit.')
console.log('═'.repeat(70))
