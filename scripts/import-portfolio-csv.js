#!/usr/bin/env node

/**
 * import-portfolio-csv.js — One-shot backfill of portfolio investment data from
 * "Deal Pipeline - Portfolio.csv" into the org_companies table.
 *
 * Pipeline:
 *
 *   CSV file on disk
 *         │
 *         ▼
 *   [1] csv-parse/sync → array of row objects (handles quoted multi-line cells)
 *         │
 *         ▼
 *   [2] Load all org_companies into memory: id, canonical_name, normalized_name
 *         │
 *         ▼
 *   [3] For each CSV row:
 *         a. Fuzzy-match Company column against existing portfolio company
 *            (exact normalized → Jaro-Winkler ≥ 0.88, with dba/legal-name fallback)
 *         b. Build field-update map (skip blank cells — never overwrite with null)
 *         c. Resolve three investor lists; auto-create new vc_fund companies for
 *            unmatched investor names (cached by normalized name within the run)
 *         │
 *         ▼
 *   [4] BEGIN TRANSACTION (only if --commit, else dry-run prints decisions)
 *       For each matched portfolio row:
 *         - INSERT new vc_fund companies (if any)
 *         - UPDATE org_companies SET <fields>, updated_at=now WHERE id=?
 *         - INSERT INTO company_investors (merge — only NEW links)
 *       COMMIT
 *
 * Usage:
 *   node scripts/import-portfolio-csv.js [csv_path] [options]
 *
 * Options:
 *   --csv <path>     CSV path (default: ~/Apps/Cyggie/import/Deal Pipeline - Portfolio.csv)
 *   --db  <path>     SQLite DB path (default: ~/Documents/MeetingIntelligence/echovault.db)
 *   --dry-run        Print decisions, no DB writes (DEFAULT)
 *   --commit         Actually write to DB (after backup)
 *   --no-backup      Skip DB backup before write
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const Database = require('better-sqlite3')
const { parse: parseCsv } = require('csv-parse/sync')

const DEFAULT_CSV_PATH = path.join(os.homedir(), 'Apps', 'Cyggie', 'import', 'Deal Pipeline - Portfolio.csv')
const DEFAULT_DB_PATH = path.join(os.homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')
const FUZZY_THRESHOLD_PORTFOLIO = 0.88   // matches repo's FUZZY_THRESHOLD; portfolio names are well-known so 0.88 is safe
const FUZZY_THRESHOLD_INVESTOR = 0.94    // tighter for investors — short VC names produce false positives at 0.88

// Manual portfolio-name overrides for renames or unmatchable cases.
// CSV name (case-insensitive) → DB canonical_name to merge into.
const PORTFOLIO_NAME_ALIASES = {
  'substrate': 'Zo Computer',  // rebranded
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printUsage() {
  console.log('Usage: node scripts/import-portfolio-csv.js [csv_path] [options]')
  console.log('')
  console.log('Options:')
  console.log(`  --csv <path>    CSV path (default: ${DEFAULT_CSV_PATH})`)
  console.log(`  --db  <path>    SQLite DB path (default: ${DEFAULT_DB_PATH})`)
  console.log('  --dry-run       Print decisions, no DB writes (DEFAULT)')
  console.log('  --commit        Write to DB (after backup)')
  console.log('  --no-backup     Skip DB backup before write')
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const opts = {
    csvPath: DEFAULT_CSV_PATH,
    dbPath: DEFAULT_DB_PATH,
    commit: false,
    backup: true,
  }
  let i = 0
  while (i < args.length) {
    const t = args[i]
    if (t === '--help' || t === '-h') { printUsage(); process.exit(0) }
    if (t === '--csv') { opts.csvPath = args[++i]; i++; continue }
    if (t === '--db')  { opts.dbPath  = args[++i]; i++; continue }
    if (t === '--dry-run') { opts.commit = false; i++; continue }
    if (t === '--commit')  { opts.commit = true;  i++; continue }
    if (t === '--no-backup') { opts.backup = false; i++; continue }
    if (!t.startsWith('--')) { opts.csvPath = t; i++; continue }
    throw new Error(`Unexpected argument: ${t}`)
  }
  return opts
}

// ─── STRING UTILITIES ─────────────────────────────────────────────────────────
// Mirrors src/main/database/repositories/org-company.repo.ts:172 normalizeCompanyName

function normalizeCompanyName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Inlined from src/main/utils/jaroWinkler.ts — keep in sync.
function jaroWinkler(a, b) {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0
  const matchWindow = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0)
  const aMatched = new Array(a.length).fill(false)
  const bMatched = new Array(b.length).fill(false)
  let matches = 0
  let transpositions = 0
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow)
    const hi = Math.min(b.length - 1, i + matchWindow)
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }
  const jaro =
    matches / a.length / 3 +
    matches / b.length / 3 +
    (matches - transpositions / 2) / matches / 3
  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(a.length, b.length)); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

// ─── COMPANY NAME ALIASING ────────────────────────────────────────────────────
// CSV has names like "PowerToolsDev, Inc. (dba Nuon)" or "Captain (frmly ClaimCredit)".
// Returns array of candidate names to try matching, most specific first.

function expandCompanyAliases(rawName) {
  const out = []
  const seen = new Set()
  const push = (s) => {
    const cleaned = s.trim()
    if (!cleaned) return
    const key = normalizeCompanyName(cleaned)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(cleaned)
  }

  push(rawName)

  // Extract dba / formerly / a.k.a. parenthetical
  const parenMatch = rawName.match(/\(\s*(?:dba|d\/b\/a|frmly|formerly|f\/k\/a|fka|aka|a\.k\.a\.)\s+([^)]+)\)/i)
  if (parenMatch) {
    push(parenMatch[1])
    // Also try the version with the parenthetical stripped
    push(rawName.replace(parenMatch[0], '').trim())
  }

  // Strip common legal suffixes for a "short name" candidate
  const stripped = rawName
    .replace(/\([^)]*\)/g, '')                                     // any parenthetical
    .replace(/,?\s*(inc|llc|ltd|corp|corporation|gmbh|co|company|sa|s\.a\.|bv|b\.v\.)\.?$/i, '')
    .trim()
  push(stripped)

  // Strip leading "The "
  if (/^the\s+/i.test(rawName)) push(rawName.replace(/^the\s+/i, ''))

  return out
}

// For portfolio matching: try matching CSV name as a *prefix* of a DB name
// (e.g. CSV "Tempo" → DB "Tempo Platform"). Only used as a last-resort fallback.
function findPortfolioPrefixMatch(rawName, companies) {
  const candidates = expandCompanyAliases(rawName)
  for (const candidate of candidates) {
    const norm = normalizeCompanyName(candidate)
    if (!norm || norm.length < 4) continue  // avoid "the", "co" etc.
    const matches = companies.filter((c) => {
      const cn = c.normalized_name
      // CSV name is the first whole word(s) of DB name, with at least one extra word
      return cn === norm || cn.startsWith(`${norm} `) || cn.endsWith(` ${norm}`)
    })
    if (matches.length === 1) return { match: matches[0], score: 0.9, candidate, prefix: true }
  }
  return null
}

// ─── VALUE PARSERS ────────────────────────────────────────────────────────────

function blank(value) {
  if (value == null) return true
  const s = String(value).trim()
  return s === '' || s.toLowerCase() === 'n/a' || s === '-'
}

function trimOrNull(value) {
  if (blank(value)) return null
  return String(value).trim()
}

function cleanDescription(value) {
  if (blank(value)) return null
  return String(value).replace(/\s+/g, ' ').trim()
}

// "Berlin, Germany" → { city: "Berlin", state: "Germany" }
// "New York, NY"    → { city: "New York", state: "NY" }
// "Dubai"           → { city: "Dubai",  state: null }
function parseLocation(value) {
  if (blank(value)) return { city: null, state: null }
  const s = String(value).trim()
  const idx = s.lastIndexOf(',')
  if (idx === -1) return { city: s, state: null }
  return {
    city: s.slice(0, idx).trim() || null,
    state: s.slice(idx + 1).trim() || null,
  }
}

// "https://getgrow.io/" or "www.expo.dev" → { url, domain }
function parseWebsite(value) {
  if (blank(value)) return { url: null, domain: null }
  let raw = String(value).trim()
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let domain = null
  try {
    const u = new URL(raw)
    domain = u.hostname.replace(/^www\./, '').toLowerCase() || null
  } catch { /* keep null */ }
  return { url: raw, domain }
}

// "$2,000,000.00" → 2_000_000 ; "$8.0" → 8 ; " " → null
function parseDollarsRaw(value) {
  if (blank(value)) return null
  const cleaned = String(value).replace(/[$,\s]/g, '')
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// REAL fields stored in millions. CSV uses two formats:
//   - "$8.0" already shorthand millions (already 8)
//   - "$2,000,000.00" raw dollars (need ÷ 1_000_000 = 2.0)
// Heuristic: if absolute value is ≥ 1000, assume raw dollars; else already millions.
function parseAsMillions(value) {
  const n = parseDollarsRaw(value)
  if (n == null) return null
  return Math.abs(n) >= 1000 ? n / 1_000_000 : n
}

// "$400,000 " → "400000"  (TEXT field, plain numeric string to match existing data)
function parseAsRawDollarsString(value) {
  const n = parseDollarsRaw(value)
  if (n == null) return null
  return String(n)
}

// "5.00%" → "5.00%"
function normalizePercent(value) {
  if (blank(value)) return null
  return String(value).trim()
}

// "8/26/21" → "2021-08-26"; passes through ISO already-formatted.
function parseDate(value) {
  if (blank(value)) return null
  const s = String(value).trim()
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // m/d/yy or m/d/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (!m) return s // best effort — leave as-is
  const month = Number(m[1])
  const day = Number(m[2])
  let year = Number(m[3])
  if (year < 100) year += year >= 70 ? 1900 : 2000
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const SECURITY_MAP = {
  'safe': 'safe',
  'preferred stock': 'preferred_stock',
  'convertible note': 'convertible_note',
  'common stock': 'common_stock',
}
function normalizeSecurity(value) {
  if (blank(value)) return null
  // "Preferred Stock, SAFE" → take first comma-separated token
  const first = String(value).split(',')[0].trim().toLowerCase()
  return SECURITY_MAP[first] || null
}

const ROUND_MAP = {
  'pre-seed': 'pre_seed',
  'preseed': 'pre_seed',
  'seed': 'seed',
  'seed+': 'seed_extension',
  'seed extension': 'seed_extension',
  'series a': 'series_a',
  'series b': 'series_b',
  'series c': 'series_c',
  'series d': 'series_d',
}
function normalizeRound(value) {
  if (blank(value)) return null
  const key = String(value).trim().toLowerCase()
  return ROUND_MAP[key] || null
}

function splitInvestors(value) {
  if (blank(value)) return []
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== 'n/a')
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────

function loadAllCompanies(db) {
  return db.prepare(`
    SELECT id, canonical_name, normalized_name
    FROM org_companies
  `).all()
}

// Returns { match: {id, canonical_name, normalized_name}, score, candidate } or null.
function fuzzyMatchCompany(rawName, companies, normalizedIndex, threshold) {
  for (const candidate of expandCompanyAliases(rawName)) {
    const normalized = normalizeCompanyName(candidate)
    if (!normalized) continue

    // Exact normalized match — fast path
    const exact = normalizedIndex.get(normalized)
    if (exact) return { match: exact, score: 1, candidate }

    // Jaro-Winkler scan
    let best = null
    let bestScore = 0
    for (const c of companies) {
      const score = jaroWinkler(normalized, c.normalized_name)
      if (score > bestScore) { bestScore = score; best = c }
    }
    if (best && bestScore >= threshold) {
      return { match: best, score: bestScore, candidate }
    }
  }
  return null
}

// Generates a UUIDv4-shaped string (matches the format used elsewhere in the repo).
function newUuid() { return crypto.randomUUID() }

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv)

  console.log('━'.repeat(72))
  console.log(`Mode:    ${opts.commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`)
  console.log(`CSV:     ${opts.csvPath}`)
  console.log(`DB:      ${opts.dbPath}`)
  console.log('━'.repeat(72))

  if (!fs.existsSync(opts.csvPath)) {
    console.error(`✗ CSV not found: ${opts.csvPath}`)
    process.exit(1)
  }
  if (!fs.existsSync(opts.dbPath)) {
    console.error(`✗ DB not found: ${opts.dbPath}`)
    process.exit(1)
  }

  // Backup before any writes
  if (opts.commit && opts.backup) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${opts.dbPath}.portfolio-csv-backup-${ts}`
    fs.copyFileSync(opts.dbPath, backupPath)
    console.log(`✓ Backup → ${backupPath}`)
  }

  // Parse CSV
  const csvBuf = fs.readFileSync(opts.csvPath)
  const rows = parseCsv(csvBuf, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
    trim: false,
  })
  console.log(`✓ Parsed ${rows.length} CSV rows`)

  const db = new Database(opts.dbPath)
  db.pragma('foreign_keys = ON')

  const companies = loadAllCompanies(db)
  const normalizedIndex = new Map(companies.map((c) => [c.normalized_name, c]))
  console.log(`✓ Loaded ${companies.length} companies from DB`)
  console.log()

  // Track stats and decisions
  const matched = []        // {csvName, dbId, dbName, score, fields, investors}
  const unmatched = []      // {csvName}
  const investorAutoCreate = new Map()  // normalized_name → {id, canonical_name, isNew, sourceName}
  const reuseInvestor = (name) => {
    const norm = normalizeCompanyName(name)
    if (!norm) return null
    if (investorAutoCreate.has(norm)) return investorAutoCreate.get(norm)
    const existing = normalizedIndex.get(norm)
    if (existing) {
      const ref = { id: existing.id, canonical_name: existing.canonical_name, isNew: false, sourceName: name.trim() }
      investorAutoCreate.set(norm, ref)
      return ref
    }
    // Try fuzzy match before deciding to create.
    // Guard: also require first-3-char prefix match so "AIR Ventures" doesn't match "IA Ventures"
    // (shared "Ventures"/"Capital" suffix dominates Jaro-Winkler when prefixes diverge).
    const normPrefix = norm.slice(0, 3)
    let best = null
    let bestScore = 0
    for (const c of companies) {
      if (c.normalized_name.slice(0, 3) !== normPrefix) continue
      const score = jaroWinkler(norm, c.normalized_name)
      if (score > bestScore) { bestScore = score; best = c }
    }
    if (best && bestScore >= FUZZY_THRESHOLD_INVESTOR) {
      const ref = { id: best.id, canonical_name: best.canonical_name, isNew: false, fuzzyScore: bestScore, sourceName: name.trim() }
      investorAutoCreate.set(norm, ref)
      return ref
    }
    // Will create new — assign id now so the rest of the run can reference it
    const ref = { id: newUuid(), canonical_name: name.trim(), normalized_name: norm, isNew: true, sourceName: name.trim() }
    investorAutoCreate.set(norm, ref)
    return ref
  }

  // ─── PASS 1: planning ─────────────────────────────────────────────────────

  for (const row of rows) {
    const csvName = (row['Company'] || '').trim()
    if (!csvName) continue

    // Manual alias override (renames etc.)
    let matchResult = null
    const aliasTarget = PORTFOLIO_NAME_ALIASES[csvName.trim().toLowerCase()]
    if (aliasTarget) {
      const aliasMatch = normalizedIndex.get(normalizeCompanyName(aliasTarget))
      if (aliasMatch) matchResult = { match: aliasMatch, score: 1, candidate: `${csvName} → ${aliasTarget} [alias]` }
    }
    if (!matchResult) {
      matchResult = fuzzyMatchCompany(csvName, companies, normalizedIndex, FUZZY_THRESHOLD_PORTFOLIO)
    }
    if (!matchResult) {
      // Last-resort prefix/contained-token match (e.g. "Tempo" → "Tempo Platform")
      matchResult = findPortfolioPrefixMatch(csvName, companies)
    }
    if (!matchResult) {
      unmatched.push({ csvName })
      continue
    }

    // Build field updates (skip blanks)
    const loc = parseLocation(row['Location'])
    const web = parseWebsite(row['Website'])
    const fields = {}
    const setIfPresent = (col, value) => { if (value != null) fields[col] = value }

    setIfPresent('description', cleanDescription(row['Description']))
    setIfPresent('city', loc.city)
    setIfPresent('state', loc.state)
    setIfPresent('sector', trimOrNull(row['Category']))
    setIfPresent('website_url', web.url)
    if (web.domain != null) fields['__domain'] = web.domain  // applied conditionally below
    setIfPresent('initial_investment_security', normalizeSecurity(row['Initial Security']))
    setIfPresent('investment_round', normalizeRound(row['Investment Round']))
    setIfPresent('date_of_initial_investment', parseDate(row['Date of 1st Investment']))
    setIfPresent('investment_size', parseAsRawDollarsString(row['Initial Investment']))
    setIfPresent('ownership_pct', normalizePercent(row['Initial Ownership']))
    setIfPresent('initial_round_size', parseAsMillions(row['Initial Round Size']))
    setIfPresent('post_money_valuation', parseAsMillions(row['Initial Valuation (Post Money)']))
    setIfPresent('total_invested', parseAsRawDollarsString(row['Total Invested']))
    setIfPresent('last_company_valuation', parseAsMillions(row['Last Company Valuation']))
    setIfPresent('round', normalizeRound(row['Last Round']))
    setIfPresent('followon_check', parseAsMillions(row['Follow-on Check']))
    setIfPresent('followon_date', parseDate(row['Follow-on date']))
    setIfPresent('followon_check_2', parseAsMillions(row['Follow-on Check 2']))
    setIfPresent('followon_date_2', parseDate(row['Follow-on date 2']))
    setIfPresent('twitter_handle', trimOrNull(row['Company X URL']))
    setIfPresent('linkedin_company_url', trimOrNull(row['Company LinkedIn URL']))

    // Always assert portfolio classification
    fields['entity_type'] = 'portfolio'
    fields['include_in_companies_view'] = 1

    // Resolve investor lists
    const investors = {
      co_investor: splitInvestors(row['CoInvestors']).map(reuseInvestor).filter(Boolean),
      prior_investor: splitInvestors(row['Prior Investors']).map(reuseInvestor).filter(Boolean),
      subsequent_investor: splitInvestors(row['Subsequent Investors']).map(reuseInvestor).filter(Boolean),
    }

    matched.push({
      csvName,
      dbId: matchResult.match.id,
      dbName: matchResult.match.canonical_name,
      score: matchResult.score,
      candidate: matchResult.candidate,
      fields,
      investors,
    })
  }

  // ─── REPORT ───────────────────────────────────────────────────────────────

  console.log(`Matched portfolio companies: ${matched.length}/${rows.filter((r) => (r['Company'] || '').trim()).length}`)
  console.log()

  for (const m of matched) {
    const matchTag = m.score === 1 ? 'EXACT' : `fuzzy ${m.score.toFixed(3)}`
    const altNote = normalizeCompanyName(m.candidate) !== normalizeCompanyName(m.csvName) ? ` via "${m.candidate}"` : ''
    console.log(`  ✓ "${m.csvName}" → "${m.dbName}" [${matchTag}${altNote}]`)
    const fieldKeys = Object.keys(m.fields).filter((k) => k !== '__domain')
    console.log(`      ${fieldKeys.length} field updates: ${fieldKeys.join(', ')}`)
    const totalInvestors = m.investors.co_investor.length + m.investors.prior_investor.length + m.investors.subsequent_investor.length
    if (totalInvestors > 0) {
      console.log(`      investors: co=${m.investors.co_investor.length} prior=${m.investors.prior_investor.length} subsequent=${m.investors.subsequent_investor.length}`)
    }
  }

  if (unmatched.length > 0) {
    console.log()
    console.log(`✗ Unmatched portfolio companies: ${unmatched.length}`)
    for (const u of unmatched) console.log(`    - "${u.csvName}"`)
  }

  // Investor companies that will be CREATED
  const newInvestors = [...investorAutoCreate.values()].filter((v) => v.isNew)
  const reusedFuzzy = [...investorAutoCreate.values()].filter((v) => !v.isNew && v.fuzzyScore != null)

  console.log()
  console.log(`Investor name resolutions: ${investorAutoCreate.size} unique names`)
  console.log(`  • Matched existing companies (exact): ${[...investorAutoCreate.values()].filter((v) => !v.isNew && v.fuzzyScore == null).length}`)
  console.log(`  • Matched existing companies (fuzzy): ${reusedFuzzy.length}`)
  console.log(`  • Will be CREATED as new vc_fund:    ${newInvestors.length}`)

  if (reusedFuzzy.length > 0) {
    console.log()
    console.log('Fuzzy investor matches (verify these are correct):')
    for (const v of reusedFuzzy) {
      console.log(`    CSV "${v.sourceName}" → DB "${v.canonical_name}" (score ${v.fuzzyScore.toFixed(3)})`)
    }
  }

  if (newInvestors.length > 0) {
    console.log()
    console.log('New vc_fund companies that WILL BE CREATED:')
    for (const v of newInvestors) console.log(`    + "${v.canonical_name}"`)
  }

  // ─── COMMIT ───────────────────────────────────────────────────────────────

  if (!opts.commit) {
    console.log()
    console.log('━'.repeat(72))
    console.log('DRY-RUN complete. Re-run with --commit to apply changes.')
    db.close()
    return
  }

  console.log()
  console.log('━'.repeat(72))
  console.log('Committing…')

  const insertCompanyStmt = db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, entity_type,
      include_in_companies_view, classification_source, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'vc_fund', 0, 'auto', 'active', datetime('now'), datetime('now'))
  `)

  const checkInvestorLinkStmt = db.prepare(`
    SELECT 1 FROM company_investors
    WHERE company_id = ? AND investor_company_id = ? AND investor_type = ?
  `)

  const maxPositionStmt = db.prepare(`
    SELECT COALESCE(MAX(position), -1) AS max_pos FROM company_investors
    WHERE company_id = ? AND investor_type = ?
  `)

  const insertInvestorLinkStmt = db.prepare(`
    INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `)

  const tx = db.transaction(() => {
    // 1. Insert new investor companies
    for (const v of newInvestors) {
      insertCompanyStmt.run(v.id, v.canonical_name, v.normalized_name)
    }

    // 2. Update each matched company + merge investor links
    let totalLinksAdded = 0
    let totalLinksSkipped = 0

    for (const m of matched) {
      // Build dynamic UPDATE
      const setClauses = []
      const values = []
      for (const [col, val] of Object.entries(m.fields)) {
        if (col === '__domain') continue
        setClauses.push(`${col} = ?`)
        values.push(val)
      }
      // primary_domain only set when currently null (don't clobber an existing curated value)
      if (m.fields['__domain']) {
        setClauses.push(`primary_domain = COALESCE(primary_domain, ?)`)
        values.push(m.fields['__domain'])
      }
      setClauses.push(`updated_at = datetime('now')`)

      const sql = `UPDATE org_companies SET ${setClauses.join(', ')} WHERE id = ?`
      values.push(m.dbId)
      db.prepare(sql).run(...values)

      // Merge investor links
      for (const investorType of ['co_investor', 'prior_investor', 'subsequent_investor']) {
        const refs = m.investors[investorType]
        if (refs.length === 0) continue
        const baseRow = maxPositionStmt.get(m.dbId, investorType)
        let nextPos = baseRow.max_pos + 1
        for (const ref of refs) {
          const exists = checkInvestorLinkStmt.get(m.dbId, ref.id, investorType)
          if (exists) { totalLinksSkipped++; continue }
          insertInvestorLinkStmt.run(newUuid(), m.dbId, ref.id, investorType, nextPos)
          nextPos++
          totalLinksAdded++
        }
      }
    }

    console.log(`✓ Updated ${matched.length} companies`)
    console.log(`✓ Inserted ${newInvestors.length} new vc_fund investor companies`)
    console.log(`✓ Inserted ${totalLinksAdded} new investor links (${totalLinksSkipped} already existed)`)
  })

  try {
    tx()
    console.log('✓ Transaction committed')
  } catch (err) {
    console.error('✗ Transaction failed:', err.message)
    process.exit(1)
  } finally {
    db.close()
  }
}

main()
