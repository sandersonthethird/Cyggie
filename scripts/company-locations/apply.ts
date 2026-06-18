/**
 * apply.ts — write the reviewed company-location draft into SQLite through the
 * sync barrel so the updates reach Neon (mobile).
 *
 * Reads the hand-reviewed draft.csv (see build-draft.py) and, for every row
 * with action=apply, fills ONLY the company fields that are still empty in the
 * live DB — it never overwrites an existing value. Writes go through the barrel
 * `updateCompany`, which runs inside `withSync` → emits an org_companies
 * `update` outbox entry with field-LWW lamports → the SyncAgent drains it.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.node.json scripts/company-locations/apply.ts --file scripts/company-locations/draft.csv            # dry-run (default)
 *   npx tsx --tsconfig tsconfig.node.json scripts/company-locations/apply.ts --file scripts/company-locations/draft.csv --apply    # write
 *
 * IMPORTANT: quit the desktop app before --apply so the two processes don't
 * contend for the SQLite write lock.
 *
 * The barrel's repo internally calls getDatabase() → getDatabasePath() →
 * electron `app.getPath`. We're not in Electron, so we stub the `electron`
 * module (CJS _load hook) to return the real ~/Documents path BEFORE requiring
 * the barrel. getDatabase() then opens the real echovault.db, and both withSync
 * (configured getDb) and the inner repo share that one connection.
 */
import Module from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import BetterSqlite3 from 'better-sqlite3'

const DB_PATH = join(homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')

// Draft column -> updateCompany() (camelCase) field / live DB (snake_case) column.
const FIELDS = [
  { csv: 'city', repo: 'city', col: 'city' },
  { csv: 'state', repo: 'state', col: 'state' },
  { csv: 'website', repo: 'websiteUrl', col: 'website_url' },
  { csv: 'domain', repo: 'primaryDomain', col: 'primary_domain' },
  { csv: 'industry', repo: 'industry', col: 'industry' },
] as const

interface Args {
  file: string
  apply: boolean
}

function parseArgs(argv: string[]): Args {
  let file = ''
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--file') file = argv[++i] ?? ''
    else if (a === '--apply') apply = true
    else if (a === '--dry-run') apply = false
    else {
      console.error(`Unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!file) {
    console.error('Usage: apply.ts --file <draft.csv> [--apply]')
    process.exit(2)
  }
  if (!existsSync(file)) {
    console.error(`✗ draft file not found: ${file}`)
    process.exit(2)
  }
  return { file, apply }
}

/** Minimal RFC-4180 CSV parser (handles quoted fields with commas/newlines). */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c === '\r') { /* skip */ }
    else field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  if (rows.length === 0) return []
  const header = rows[0]!
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}

function isEmpty(v: unknown): boolean {
  return v == null || String(v).trim() === ''
}

/** Normalize the action cell. 'ap' is a known typo for 'apply'. */
function normAction(a: string | undefined): string {
  const v = (a || '').trim().toLowerCase()
  if (v === 'ap') return 'apply'
  return v
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const draft = parseCsv(readFileSync(args.file, 'utf8'))
  const toApply = draft.filter((r) => normAction(r['action']) === 'apply')
  const toDelete = draft.filter((r) => normAction(r['action']) === 'delete')
  console.log(`Draft: ${draft.length} rows — ${toApply.length} apply, ${toDelete.length} delete`)
  console.log(args.apply ? '*** APPLY MODE — writing through sync barrel ***' : '— DRY RUN (no writes); pass --apply to write —')

  // Read connection (read-only in dry-run; the barrel's own getDatabase in apply mode).
  let readDb: BetterSqlite3.Database
  let updateCompany: ((id: string, data: Record<string, unknown>, userId: string | null) => unknown) | null = null
  let deleteCompany: ((id: string) => unknown) | null = null
  let userId: string | null = null

  if (args.apply) {
    // Stub electron BEFORE requiring the barrel (it transitively needs app.getPath).
    const M = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown }
    const origLoad = M._load
    M._load = function (request: string, ...rest: unknown[]) {
      if (request === 'electron') {
        return { app: { getPath: (k: string) => (k === 'documents' ? join(homedir(), 'Documents') : homedir()) } }
      }
      return origLoad.call(this, request, ...rest)
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDatabase } = require('@cyggie/db/sqlite/connection')
    const { configureSyncGlobals } = require('@cyggie/db/sqlite/repositories/_sync')
    const barrel = require('@cyggie/db/sqlite/repositories')
    updateCompany = barrel.updateCompany
    deleteCompany = barrel.deleteCompany
    readDb = getDatabase() as BetterSqlite3.Database

    const idRow = readDb
      .prepare(`SELECT user_id, device_id FROM sync_state ORDER BY last_seen_at DESC LIMIT 1`)
      .get() as { user_id: string; device_id: string } | undefined
    if (!idRow) {
      console.error('✗ No sync_state row — cannot resolve user/device identity. Aborting.')
      process.exit(2)
    }
    userId = idRow.user_id
    const deviceId = idRow.device_id
    console.log(`Identity: user=${userId} device=${deviceId}`)
    configureSyncGlobals({ getDb: () => readDb, getUserId: () => userId, getDeviceId: () => deviceId })
  } else {
    readDb = new BetterSqlite3(DB_PATH, { readonly: true })
  }

  const liveStmt = readDb.prepare(
    `SELECT city, state, website_url, primary_domain, industry FROM org_companies WHERE id = ?`,
  )

  const perField: Record<string, number> = { city: 0, state: 0, website: 0, domain: 0, industry: 0 }
  let changedRows = 0
  let skippedNoGap = 0
  let notFound = 0
  const examples: string[] = []

  for (const r of toApply) {
    const id = r['id']
    if (!id) continue
    const live = liveStmt.get(id) as Record<string, unknown> | undefined
    if (!live) { notFound++; continue }

    const patch: Record<string, unknown> = {}
    const touched: string[] = []
    for (const f of FIELDS) {
      const val = (r[f.csv] || '').trim()
      if (val && isEmpty(live[f.col])) {
        patch[f.repo] = val
        perField[f.csv]!++
        touched.push(`${f.csv}=${val}`)
      }
    }

    if (Object.keys(patch).length === 0) { skippedNoGap++; continue }
    changedRows++
    if (examples.length < 12) examples.push(`  ${r['name']}: ${touched.join(', ')}`)

    if (args.apply) {
      try {
        updateCompany!(id, patch, userId)
      } catch (e) {
        console.error(`✗ updateCompany failed for ${r['name']} (${id}): ${(e as Error).message}`)
      }
    }
  }

  console.log('\nPlanned/applied changes (gaps only — existing values never overwritten):')
  for (const k of Object.keys(perField)) console.log(`  ${k.padEnd(9)}: ${perField[k]}`)
  console.log(`\nRows changed: ${changedRows}`)
  console.log(`Rows skipped (no gap / already filled): ${skippedNoGap}`)
  if (notFound) console.log(`Rows skipped (company id not found): ${notFound}`)
  console.log('\nSample:')
  console.log(examples.join('\n'))

  // --- Deletions (hard delete via barrel, emits a delete tombstone to sync) ---
  let deleted = 0
  let deleteNotFound = 0
  if (toDelete.length > 0) {
    console.log(`\n${args.apply ? 'Deleting' : 'Would delete'} ${toDelete.length} companies:`)
    for (const r of toDelete) {
      const id = r['id']
      if (!id) continue
      const live = liveStmt.get(id)
      if (!live) { deleteNotFound++; console.log(`  (already gone) ${r['name']}`); continue }
      console.log(`  ${r['name']}`)
      if (args.apply) {
        try {
          deleteCompany!(id)
          deleted++
        } catch (e) {
          console.error(`✗ deleteCompany failed for ${r['name']} (${id}): ${(e as Error).message}`)
        }
      }
    }
    if (!args.apply) console.log(`  (${toDelete.length} marked; ${deleteNotFound} already gone)`)
  }

  if (args.apply) {
    const upd = (readDb
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='org_companies' AND op='update'`)
      .get() as { n: number }).n
    const del = (readDb
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE table_name='org_companies' AND op='delete'`)
      .get() as { n: number }).n
    console.log(`\nApplied: ${changedRows} updated, ${deleted} deleted.`)
    console.log(`Outbox org_companies entries now: ${upd} update, ${del} delete`)
    console.log('Done. The SyncAgent will drain these to Neon on its next tick.')
  } else {
    console.log('\nDry run complete. Re-run with --apply (after quitting the desktop app) to write.')
  }
}

main()
