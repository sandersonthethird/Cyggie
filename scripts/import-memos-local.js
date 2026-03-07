#!/usr/bin/env node

/**
 * Import investment memos from local markdown files into the database.
 * Uses explicit company name overrides for files that would otherwise fuzzy-match incorrectly.
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')
const Database = require('better-sqlite3')

const DB_PATH = path.join(os.homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db')
const MEMOS_DIR = path.resolve(__dirname, '..', 'import', 'memos', 'raw')

// Explicit company name overrides for files where auto-extraction gets it wrong
const COMPANY_OVERRIDES = {
  'Captain__ClaimCredit__-_Red_Swan_Investment_Memo.md': 'Captain',
  'Castle.xyz_-_Red_Swan_Investment_Memo.md': 'Castle',
  'Hawkhill_Homes_-_Red_Swan_Investment_Memo.md': 'Hawkhill Homes',
  'Investment_Memo__Man_Cereal.md': 'Man Cereal',
  'Investment_Memo__Spacture_Ai.md': 'Spacture',
  'Nuon__Launchpad__-_Red_Swan_Investment_Memo.md': 'Nuon',
  'Prizeout_Partners_-_Investment_Memo__June_2024_.md': 'Prizeout',
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function extractCompanyName(filename) {
  if (COMPANY_OVERRIDES[filename]) return COMPANY_OVERRIDES[filename]

  const stem = path.basename(filename, '.md')
  const name = stem.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()

  // "Company - Red Swan Investment Memo"
  const m1 = name.match(/^(.+?)\s*-\s*Red Swan Investment Memo/i)
  if (m1) return m1[1].trim()

  // "Investment Memo: Company" or "Investment Memo  Company"
  const m2 = name.match(/Investment Memo\s*[:\s]\s*(.+)$/i)
  if (m2) {
    let co = m2[1].trim()
    // strip trailing google doc ID hashes
    co = co.replace(/\s+[A-Za-z0-9_-]{25,}$/, '').trim()
    return co
  }

  // "Company - Investment Memo (date)"
  const m3 = name.match(/^(.+?)\s*-\s*Investment Memo/i)
  if (m3) return m3[1].trim()

  // "Red Swan Capsule Investment Memo" → strip known suffixes
  return name
    .replace(/\bRed Swan Investment Memo\b/gi, '')
    .replace(/\bInvestment Memo\b/gi, '')
    .replace(/\bInternal\b/gi, '')
    .replace(/\bDraft\b/gi, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[-:|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function findCompanyByNormalizedName(db, name) {
  const normalized = normalizeName(name)
  if (!normalized) return null

  // Exact normalized name match
  const row = db.prepare('SELECT id, canonical_name FROM org_companies WHERE normalized_name = ? LIMIT 1').get(normalized)
  if (row) return row

  // Alias match
  const alias = db.prepare(`
    SELECT company_id FROM org_company_aliases
    WHERE alias_type = 'name' AND lower(trim(alias_value)) = ?
    LIMIT 1
  `).get(normalized)
  if (alias) {
    const company = db.prepare('SELECT id, canonical_name FROM org_companies WHERE id = ? LIMIT 1').get(alias.company_id)
    if (company) return company
  }

  return null
}

function createCompany(db, name) {
  const id = crypto.randomUUID()
  const canonical = name.trim()
  const normalized = normalizeName(canonical)
  db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, status, entity_type,
      include_in_companies_view, classification_source, classification_confidence,
      created_at, updated_at
    )
    VALUES (?, ?, ?, 'active', 'prospect', 1, 'manual', 1, datetime('now'), datetime('now'))
  `).run(id, canonical, normalized)

  db.prepare(`
    INSERT OR IGNORE INTO org_company_aliases (id, company_id, alias_value, alias_type, created_at)
    VALUES (?, ?, ?, 'name', datetime('now'))
  `).run(crypto.randomUUID(), id, canonical)

  return { id, canonical_name: canonical }
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

function run() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`)
    process.exit(1)
  }
  if (!fs.existsSync(MEMOS_DIR)) {
    console.error(`Memos directory not found: ${MEMOS_DIR}`)
    process.exit(1)
  }

  const files = fs.readdirSync(MEMOS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()

  if (files.length === 0) {
    console.log('No markdown files found.')
    return
  }

  console.log(`Found ${files.length} memo files`)
  console.log(`DB: ${DB_PATH}`)
  console.log()

  const db = new Database(DB_PATH)
  db.pragma('foreign_keys = ON')

  const findLatestMemo = db.prepare(`
    SELECT id, title, latest_version_number
    FROM investment_memos WHERE company_id = ?
    ORDER BY datetime(updated_at) DESC LIMIT 1
  `)
  const insertMemo = db.prepare(`
    INSERT INTO investment_memos (id, company_id, title, status, latest_version_number, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'draft', 0, 'Memo Import', datetime('now'), datetime('now'))
  `)
  const getLatestVersion = db.prepare(`
    SELECT id, version_number, content_markdown
    FROM investment_memo_versions WHERE memo_id = ?
    ORDER BY version_number DESC LIMIT 1
  `)
  const insertVersion = db.prepare(`
    INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown, structured_json, change_note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Memo Import', datetime('now'))
  `)
  const updateMemoLatest = db.prepare(`
    UPDATE investment_memos SET latest_version_number = ?, updated_at = datetime('now') WHERE id = ?
  `)

  let imported = 0
  let skippedDuplicate = 0
  let created = 0
  let failed = 0

  const importAll = db.transaction(() => {
    for (const filename of files) {
      const companyName = extractCompanyName(filename)
      if (!companyName) {
        console.warn(`  SKIP ${filename}: could not extract company name`)
        failed++
        continue
      }

      let company = findCompanyByNormalizedName(db, companyName)
      if (!company) {
        company = createCompany(db, companyName)
        created++
        console.log(`  NEW  company: "${companyName}"`)
      }

      const content = fs.readFileSync(path.join(MEMOS_DIR, filename), 'utf8').trim()
      if (!content) {
        console.warn(`  SKIP ${filename}: empty content`)
        failed++
        continue
      }

      const contentHash = hashContent(content)

      const existingMemo = findLatestMemo.get(company.id)
      let memoId = existingMemo ? existingMemo.id : null

      if (!memoId) {
        memoId = crypto.randomUUID()
        insertMemo.run(memoId, company.id, `${company.canonical_name} Investment Memo`)
      }

      const latestVersion = getLatestVersion.get(memoId)
      if (latestVersion && hashContent(latestVersion.content_markdown || '') === contentHash) {
        skippedDuplicate++
        console.log(`  DUP  ${filename} → ${company.canonical_name} (already imported)`)
        continue
      }

      const versionNumber = latestVersion ? latestVersion.version_number + 1 : 1
      const structuredJson = JSON.stringify({
        source: 'local-folder',
        sourcePath: path.join(MEMOS_DIR, filename),
        importedAt: new Date().toISOString(),
        contentHash
      })

      const versionId = crypto.randomUUID()
      insertVersion.run(versionId, memoId, versionNumber, content, structuredJson, `Imported from ${filename}`)
      updateMemoLatest.run(versionNumber, memoId)

      imported++
      console.log(`  OK   ${filename} → ${company.canonical_name} (v${versionNumber})`)
    }
  })

  try {
    importAll()
  } catch (err) {
    console.error('Import failed, transaction rolled back:', err.message)
    db.close()
    process.exit(1)
  }

  db.close()

  console.log()
  console.log('Done!')
  console.log(`  Imported: ${imported}`)
  console.log(`  Duplicate (skipped): ${skippedDuplicate}`)
  console.log(`  New companies created: ${created}`)
  console.log(`  Failed: ${failed}`)
}

run()
