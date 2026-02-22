#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const Database = require('better-sqlite3')

const COMMON_PROVIDER_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'icloud.com',
  'aol.com',
  'protonmail.com',
  'me.com',
  'live.com',
  'msn.com',
  'zoho.com',
  'fastmail.com'
])

function printUsage() {
  console.log(
    'Usage: node scripts/import-granola.js <csv_path> [--db <db_path>] [--dry-run] [--no-backup]'
  )
}

function parseArgs(argv) {
  const args = argv.slice(2)
  if (args.length === 0) {
    printUsage()
    process.exit(1)
  }

  const options = {
    csvPath: '',
    dbPath: path.join(os.homedir(), 'Documents', 'MeetingIntelligence', 'echovault.db'),
    dryRun: false,
    backup: true
  }

  let i = 0
  while (i < args.length) {
    const token = args[i]
    if (token === '--db') {
      const next = args[i + 1]
      if (!next) {
        throw new Error('--db requires a path')
      }
      options.dbPath = next
      i += 2
      continue
    }
    if (token === '--dry-run') {
      options.dryRun = true
      i += 1
      continue
    }
    if (token === '--no-backup') {
      options.backup = false
      i += 1
      continue
    }
    if (!options.csvPath) {
      options.csvPath = token
      i += 1
      continue
    }
    throw new Error(`Unexpected argument: ${token}`)
  }

  if (!options.csvPath) {
    throw new Error('CSV path is required')
  }

  return options
}

function parseCsv(content) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }

    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }

    if (ch === '\r') {
      if (content[i + 1] === '\n') {
        continue
      }
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    field += ch
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

function normalizeEmail(value) {
  if (!value) return null
  const trimmed = String(value).trim().toLowerCase().replace(/^mailto:/, '')
  const cleaned = trimmed.replace(/^<+|>+$/g, '').replace(/[;,]+$/g, '')
  if (!cleaned || !cleaned.includes('@')) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null
  return cleaned
}

function inferNameFromEmail(email) {
  const local = (email.split('@')[0] || '').trim()
  if (!local) return email
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function splitSemicolonList(value) {
  if (!value) return []
  return String(value)
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseAttendeeEntry(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  // Handles:
  // - Name (email@domain.com)
  // - Name <email@domain.com>
  const groupedEmailMatch = trimmed.match(/^(.*?)[(<]\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*[)>]\s*$/i)
  if (groupedEmailMatch) {
    const email = normalizeEmail(groupedEmailMatch[2])
    const rawName = (groupedEmailMatch[1] || '').trim().replace(/^["']+|["']+$/g, '')
    const name = rawName || (email ? inferNameFromEmail(email) : null)
    const display = email && name ? `${name} (${email})` : (email || name || trimmed)
    return { name, email, display }
  }

  const emailOnly = normalizeEmail(trimmed)
  if (emailOnly) {
    const name = inferNameFromEmail(emailOnly)
    return { name, email: emailOnly, display: `${name} (${emailOnly})` }
  }

  // Fallback: no valid email found, keep display text for attendees array.
  return { name: trimmed, email: null, display: trimmed }
}

function normalizeCompanyName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeCompanyKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function compact(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function extractDomainFromEmail(email) {
  const normalized = normalizeEmail(email)
  if (!normalized) return null
  const domain = normalized.split('@')[1] || ''
  if (!domain) return null
  return domain.replace(/^www\./, '')
}

function domainBase(domain) {
  const normalized = String(domain || '').toLowerCase().replace(/^www\./, '')
  const parts = normalized.split('.').filter(Boolean)
  return parts.length > 0 ? parts[0] : normalized
}

function humanizeDomain(domain) {
  const base = domainBase(domain)
  const words = base
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return base
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function selectMeetingCompanies({
  attendeeCompanies,
  attendeeEmails,
  title,
  userEmail
}) {
  const titleCompact = compact(title)
  const titleWords = new Set(
    String(title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  )
  const userDomain = extractDomainFromEmail(userEmail)

  const candidateMap = new Map()

  function addCandidate(name, source, domain) {
    const cleanedName = normalizeCompanyName(name)
    if (!cleanedName) return

    const key = normalizeCompanyKey(cleanedName)
    if (!key) return

    const existing = candidateMap.get(key)
    if (existing) {
      existing.sources.add(source)
      if (domain) existing.domains.add(domain)
      return
    }

    candidateMap.set(key, {
      key,
      name: cleanedName,
      sources: new Set([source]),
      domains: new Set(domain ? [domain] : [])
    })
  }

  for (const company of attendeeCompanies) {
    addCandidate(company, 'attendee_companies', null)
  }

  for (const email of attendeeEmails) {
    const domain = extractDomainFromEmail(email)
    if (!domain) continue
    if (COMMON_PROVIDER_DOMAINS.has(domain)) continue
    if (userDomain && domain === userDomain) continue
    addCandidate(humanizeDomain(domain), 'email_domain', domain)
  }

  const candidates = [...candidateMap.values()].map((candidate) => {
    const nameCompact = compact(candidate.name)
    const nameWords = candidate.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)

    const domainHit = [...candidate.domains].some((d) => {
      const base = compact(domainBase(d))
      return base.length >= 4 && titleCompact.includes(base)
    })
    const nameHit =
      (nameCompact.length >= 4 && titleCompact.includes(nameCompact))
      || nameWords.some((w) => titleWords.has(w))

    const titleMatched = domainHit || nameHit
    const score =
      (titleMatched ? 100 : 0)
      + (candidate.sources.has('attendee_companies') ? 10 : 0)
      + (candidate.sources.has('email_domain') ? 2 : 0)

    return {
      ...candidate,
      titleMatched,
      score
    }
  })

  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

  const titleMatched = candidates.filter((c) => c.titleMatched)
  if (titleMatched.length > 0) {
    return titleMatched.slice(0, 5)
  }

  const attendeeBackstop = candidates.filter((c) => c.sources.has('attendee_companies'))
  if (attendeeBackstop.length === 1) {
    return attendeeBackstop
  }
  if (attendeeBackstop.length > 1 && attendeeBackstop.length <= 3) {
    return attendeeBackstop
  }

  const domainBackstop = candidates.filter((c) => c.sources.has('email_domain'))
  if (domainBackstop.length === 1) {
    return domainBackstop
  }

  return []
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function backupFile(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${filePath}.granola-backup-${stamp}`
  fs.copyFileSync(filePath, backupPath)
  return backupPath
}

function toIsoDate(value) {
  const parsed = new Date(String(value || '').trim())
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString()
}

function safeSummaryFilename(meetingId) {
  const cleaned = String(meetingId || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${cleaned || crypto.randomUUID()}.md`
}

function main() {
  const options = parseArgs(process.argv)

  if (!fs.existsSync(options.csvPath)) {
    throw new Error(`CSV file not found: ${options.csvPath}`)
  }
  if (!fs.existsSync(options.dbPath)) {
    throw new Error(`Database file not found: ${options.dbPath}`)
  }

  const db = new Database(options.dbPath)
  db.pragma('foreign_keys = ON')

  let storagePath = path.dirname(options.dbPath)
  const storageSetting = db
    .prepare("SELECT value FROM settings WHERE key = 'storagePath' LIMIT 1")
    .get()
  if (storageSetting && storageSetting.value && String(storageSetting.value).trim()) {
    storagePath = String(storageSetting.value).trim()
  }

  const summariesDir = path.join(storagePath, 'summaries')
  ensureDir(summariesDir)

  if (options.backup && !options.dryRun) {
    const backupPath = backupFile(options.dbPath)
    console.log(`DB backup created: ${backupPath}`)
  }

  const csvRaw = fs.readFileSync(options.csvPath, 'utf8')
  const rows = parseCsv(csvRaw)
  if (rows.length < 2) {
    throw new Error('CSV has no data rows')
  }

  const headers = rows[0].map((h) => String(h || '').replace(/^\uFEFF/, '').trim())
  const headerIndex = new Map(headers.map((h, idx) => [h, idx]))

  const required = ['document_id', 'user_email', 'document_title', 'document_created']
  for (const col of required) {
    if (!headerIndex.has(col)) {
      throw new Error(`Missing required CSV column: ${col}`)
    }
  }

  const selectMeetingById = db.prepare('SELECT id FROM meetings WHERE id = ?')
  const deleteMeetingFts = db.prepare('DELETE FROM meetings_fts WHERE meeting_id = ?')
  const insertMeetingFts = db.prepare(
    'INSERT INTO meetings_fts (meeting_id, title, transcript_text, summary_text) VALUES (?, ?, ?, ?)'
  )
  const upsertMeeting = db.prepare(`
    INSERT INTO meetings (
      id, title, date, calendar_event_id, summary_path, notes, speaker_count, speaker_map,
      attendees, attendee_emails, companies, status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 0, '{}', ?, ?, ?, 'summarized', datetime('now'), datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      date = excluded.date,
      calendar_event_id = excluded.calendar_event_id,
      summary_path = excluded.summary_path,
      notes = excluded.notes,
      attendees = excluded.attendees,
      attendee_emails = excluded.attendee_emails,
      companies = excluded.companies,
      status = 'summarized',
      updated_at = datetime('now')
  `)

  const companyCols = db
    .prepare("PRAGMA table_info('org_companies')")
    .all()
    .map((c) => c.name)
  const hasCompanyClassification = companyCols.includes('entity_type')

  const upsertCompany = hasCompanyClassification
    ? db.prepare(`
      INSERT INTO org_companies (
        id, canonical_name, normalized_name, primary_domain,
        entity_type, include_in_companies_view, classification_source, classification_confidence,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, 'prospect', 1, 'manual', 1, datetime('now'), datetime('now')
      )
      ON CONFLICT(normalized_name) DO UPDATE SET
        canonical_name = excluded.canonical_name,
        primary_domain = COALESCE(org_companies.primary_domain, excluded.primary_domain),
        updated_at = datetime('now')
    `)
    : db.prepare(`
      INSERT INTO org_companies (
        id, canonical_name, normalized_name, primary_domain, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, datetime('now'), datetime('now')
      )
      ON CONFLICT(normalized_name) DO UPDATE SET
        canonical_name = excluded.canonical_name,
        primary_domain = COALESCE(org_companies.primary_domain, excluded.primary_domain),
        updated_at = datetime('now')
    `)

  const upgradeUnknownCompany = hasCompanyClassification
    ? db.prepare(`
      UPDATE org_companies
      SET
        entity_type = 'prospect',
        include_in_companies_view = 1,
        classification_source = 'manual',
        classification_confidence = 1,
        updated_at = datetime('now')
      WHERE id = ? AND (entity_type IS NULL OR entity_type = 'unknown')
    `)
    : null

  const selectCompanyByNormalizedName = db.prepare(
    'SELECT id FROM org_companies WHERE normalized_name = ? LIMIT 1'
  )
  const upsertMeetingCompanyLink = db.prepare(`
    INSERT INTO meeting_company_links (meeting_id, company_id, confidence, linked_by, created_at)
    VALUES (?, ?, ?, 'import', datetime('now'))
    ON CONFLICT(meeting_id, company_id) DO UPDATE SET
      confidence = excluded.confidence,
      linked_by = 'import'
  `)

  const upsertContact = db.prepare(`
    INSERT INTO contacts (
      id, full_name, normalized_name, email, primary_company_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, datetime('now'), datetime('now')
    )
    ON CONFLICT(email) DO UPDATE SET
      full_name = CASE
        WHEN TRIM(excluded.full_name) <> '' THEN excluded.full_name
        ELSE contacts.full_name
      END,
      normalized_name = CASE
        WHEN TRIM(excluded.normalized_name) <> '' THEN excluded.normalized_name
        ELSE contacts.normalized_name
      END,
      primary_company_id = COALESCE(contacts.primary_company_id, excluded.primary_company_id),
      updated_at = datetime('now')
  `)
  const selectContactByEmail = db.prepare('SELECT id FROM contacts WHERE email = ? LIMIT 1')
  const upsertOrgCompanyContact = db.prepare(`
    INSERT INTO org_company_contacts (company_id, contact_id, role_label, is_primary, created_at)
    VALUES (?, ?, 'attendee', 0, datetime('now'))
    ON CONFLICT(company_id, contact_id) DO NOTHING
  `)

  const stats = {
    totalRows: 0,
    processed: 0,
    skipped: 0,
    meetingsInserted: 0,
    meetingsUpdated: 0,
    companiesLinked: 0,
    contactsUpserted: 0,
    summariesWritten: 0,
    errors: 0
  }

  for (let rowIdx = 1; rowIdx < rows.length; rowIdx += 1) {
    stats.totalRows += 1
    const row = rows[rowIdx]

    const getValue = (key) => {
      const idx = headerIndex.get(key)
      return idx === undefined ? '' : (row[idx] || '')
    }

    const documentId = String(getValue('document_id') || '').trim()
    const meetingId = documentId || crypto.randomUUID()
    const userEmail = String(getValue('user_email') || '').trim()
    const title = String(getValue('document_title') || '').trim() || 'Imported Meeting'
    const dateIso = toIsoDate(getValue('document_created'))

    if (!dateIso) {
      stats.skipped += 1
      continue
    }

    const summaryRaw = String(getValue('summary') || '').trim()
    const notesRaw = String(getValue('notes') || '').trim()
    const otherAttendeesRaw = String(getValue('other_attendees') || '')
    const attendeeCompaniesRaw = String(getValue('attendee_companies') || '')

    const attendeeEntries = splitSemicolonList(otherAttendeesRaw)
    const parsedAttendees = attendeeEntries
      .map(parseAttendeeEntry)
      .filter(Boolean)

    const attendeeDisplays = []
    const attendeeEmailSet = new Set()

    for (const attendee of parsedAttendees) {
      if (attendee.display) attendeeDisplays.push(attendee.display)
      if (attendee.email) attendeeEmailSet.add(attendee.email)
    }

    const attendeeEmails = [...attendeeEmailSet]
    const attendeeCompanies = [...new Set(splitSemicolonList(attendeeCompaniesRaw).map(normalizeCompanyName).filter(Boolean))]

    const selectedCompanies = selectMeetingCompanies({
      attendeeCompanies,
      attendeeEmails,
      title,
      userEmail
    })

    const selectedCompanyNames = selectedCompanies.map((company) => company.name)
    const summaryContent = summaryRaw || notesRaw || ''
    const notesValue = summaryRaw && notesRaw ? notesRaw : null

    let summaryPath = null
    if (summaryContent) {
      summaryPath = safeSummaryFilename(meetingId)
      if (!options.dryRun) {
        fs.writeFileSync(path.join(summariesDir, summaryPath), summaryContent, 'utf8')
      }
      stats.summariesWritten += 1
    }

    try {
      const existing = selectMeetingById.get(meetingId)
      if (existing) stats.meetingsUpdated += 1
      else stats.meetingsInserted += 1

      if (!options.dryRun) {
        upsertMeeting.run(
          meetingId,
          title,
          dateIso,
          `granola:${meetingId}`,
          summaryPath,
          notesValue,
          attendeeDisplays.length > 0 ? JSON.stringify(attendeeDisplays) : null,
          attendeeEmails.length > 0 ? JSON.stringify(attendeeEmails) : null,
          selectedCompanyNames.length > 0 ? JSON.stringify(selectedCompanyNames) : null
        )

        const summaryForSearch = [summaryRaw, notesRaw].filter(Boolean).join('\n\n')
        deleteMeetingFts.run(meetingId)
        insertMeetingFts.run(meetingId, title, '', summaryForSearch)
      }

      const selectedCompanyIds = new Map()
      for (const company of selectedCompanies) {
        const normalizedName = normalizeCompanyKey(company.name)
        if (!normalizedName) continue

        const candidateDomain = [...company.domains][0] || null
        if (!options.dryRun) {
          upsertCompany.run(
            crypto.randomUUID(),
            company.name,
            normalizedName,
            candidateDomain
          )
          const rowId = selectCompanyByNormalizedName.get(normalizedName)
          if (rowId && rowId.id) {
            selectedCompanyIds.set(company.key, rowId.id)
            if (upgradeUnknownCompany) {
              upgradeUnknownCompany.run(rowId.id)
            }
            upsertMeetingCompanyLink.run(meetingId, rowId.id, company.titleMatched ? 0.95 : 0.7)
            stats.companiesLinked += 1
          }
        }
      }

      for (const attendee of parsedAttendees) {
        if (!attendee.email) continue
        const email = attendee.email
        const fullName = attendee.name || inferNameFromEmail(email)
        const normalizedName = normalizeCompanyKey(fullName)

        let primaryCompanyId = null
        const emailDomain = extractDomainFromEmail(email)
        if (emailDomain) {
          const matchingCompany = selectedCompanies.find((company) =>
            [...company.domains].some((domain) => domain === emailDomain)
          )
          if (matchingCompany) {
            primaryCompanyId = selectedCompanyIds.get(matchingCompany.key) || null
          }
        }

        if (!options.dryRun) {
          upsertContact.run(
            crypto.randomUUID(),
            fullName,
            normalizedName,
            email,
            primaryCompanyId
          )
          const contactRow = selectContactByEmail.get(email)
          if (contactRow && contactRow.id && primaryCompanyId) {
            upsertOrgCompanyContact.run(primaryCompanyId, contactRow.id)
          }
        }
        stats.contactsUpserted += 1
      }

      stats.processed += 1
    } catch (err) {
      stats.errors += 1
      console.error(
        `[Import] Row ${rowIdx + 1} failed (document_id=${meetingId}):`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  console.log('--- Granola Import Summary ---')
  console.log(`CSV rows: ${stats.totalRows}`)
  console.log(`Processed: ${stats.processed}`)
  console.log(`Skipped: ${stats.skipped}`)
  console.log(`Errors: ${stats.errors}`)
  console.log(`Meetings inserted: ${stats.meetingsInserted}`)
  console.log(`Meetings updated: ${stats.meetingsUpdated}`)
  console.log(`Summary files written: ${stats.summariesWritten}`)
  console.log(`Meeting-company links created/updated: ${stats.companiesLinked}`)
  console.log(`Contacts upserted: ${stats.contactsUpserted}`)
  if (options.dryRun) {
    console.log('Dry run complete. No DB or file changes were written.')
  }
}

try {
  main()
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
