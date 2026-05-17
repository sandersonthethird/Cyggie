import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { extractCompanyFromEmail, extractDomainFromEmail } from '../../utils/company-extractor'

const BACKFILL_KEY = 'migration_019_company_os_backfill_v1'

interface MeetingBackfillRow {
  id: string
  title: string
  date: string
  companies: string | null
  attendee_emails: string | null
  transcript_path: string | null
  summary_path: string | null
  recording_path: string | null
}

function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function inferNameFromEmail(email: string): string {
  const local = email.split('@')[0] || email
  const first = local.split(/[._-]/)[0] || local
  return first.charAt(0).toUpperCase() + first.slice(1)
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

export function runCompanyOsBackfillMigration(db: Database.Database): void {
  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(BACKFILL_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]
  const colSet = new Set(cols.map((c) => c.name))
  if (!colSet.has('id') || !colSet.has('title') || !colSet.has('date')) {
    return
  }

  const rows = db.prepare(`
    SELECT
      id,
      title,
      date,
      ${colSet.has('companies') ? 'companies' : 'NULL AS companies'},
      ${colSet.has('attendee_emails') ? 'attendee_emails' : 'NULL AS attendee_emails'},
      ${colSet.has('transcript_path') ? 'transcript_path' : 'NULL AS transcript_path'},
      ${colSet.has('summary_path') ? 'summary_path' : 'NULL AS summary_path'},
      ${colSet.has('recording_path') ? 'recording_path' : 'NULL AS recording_path'}
    FROM meetings
  `).all() as MeetingBackfillRow[]

  const findCompanyByNormalized = db.prepare(
    'SELECT id FROM org_companies WHERE normalized_name = ?'
  )
  const insertCompany = db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, primary_domain, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `)
  const insertCompanyAlias = db.prepare(`
    INSERT OR IGNORE INTO org_company_aliases (id, company_id, alias_value, alias_type, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `)
  const insertMeetingCompanyLink = db.prepare(`
    INSERT OR IGNORE INTO meeting_company_links (
      meeting_id, company_id, confidence, linked_by, created_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
  `)

  const findContactByEmail = db.prepare('SELECT id FROM contacts WHERE email = ?')
  const upsertContact = db.prepare(`
    INSERT INTO contacts (id, full_name, normalized_name, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(email) DO UPDATE SET
      full_name = COALESCE(NULLIF(excluded.full_name, ''), contacts.full_name),
      normalized_name = COALESCE(NULLIF(excluded.normalized_name, ''), contacts.normalized_name),
      updated_at = datetime('now')
  `)
  const linkContactCompany = db.prepare(`
    INSERT OR IGNORE INTO org_company_contacts (
      company_id, contact_id, role_label, is_primary, created_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
  `)

  const findArtifactByExternal = db.prepare(`
    SELECT id FROM artifacts
    WHERE source_provider = ? AND source_external_id = ?
  `)
  const insertArtifact = db.prepare(`
    INSERT INTO artifacts (
      id, company_id, theme_id, meeting_id, artifact_type, title, mime_type,
      storage_uri, source_provider, source_external_id, content_text, captured_at,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `)
  const insertArtifactFts = db.prepare(`
    INSERT INTO artifacts_fts (artifact_id, title, content_text)
    VALUES (?, ?, ?)
  `)

  for (const row of rows) {
    const companyNames = new Set<string>()
    for (const name of parseJsonArray(row.companies)) {
      const trimmed = name.trim()
      if (trimmed) companyNames.add(trimmed)
    }

    const attendeeEmails = parseJsonArray(row.attendee_emails)
    for (const email of attendeeEmails) {
      const inferred = extractCompanyFromEmail(email)
      if (inferred) companyNames.add(inferred)
    }

    const domains = attendeeEmails
      .map((email) => extractDomainFromEmail(email))
      .filter((v): v is string => Boolean(v))

    const companyIds: string[] = []
    for (const canonicalName of companyNames) {
      const normalized = normalizeCompanyName(canonicalName)
      if (!normalized) continue

      const existing = findCompanyByNormalized.get(normalized) as { id: string } | undefined
      let companyId = existing?.id
      if (!companyId) {
        companyId = randomUUID()
        const matchingDomain = domains.find((domain) => normalized.includes(domain.split('.')[0]))
          || domains[0]
          || null
        insertCompany.run(companyId, canonicalName, normalized, matchingDomain)
      }
      companyIds.push(companyId)
      insertCompanyAlias.run(randomUUID(), companyId, canonicalName, 'name')
      insertMeetingCompanyLink.run(row.id, companyId, 0.9, 'auto')
    }

    for (const email of attendeeEmails) {
      const fullName = inferNameFromEmail(email)
      const normalizedName = fullName.toLowerCase()
      const newContactId = randomUUID()
      upsertContact.run(newContactId, fullName, normalizedName, email)
      const contact = findContactByEmail.get(email) as { id: string } | undefined
      if (contact && companyIds.length > 0) {
        linkContactCompany.run(companyIds[0], contact.id, null, 0)
      }
    }

    const seedArtifact = (
      type: 'transcript' | 'summary' | 'recording',
      storageUri: string | null
    ) => {
      if (!storageUri) return
      const externalId = `${row.id}:${type}`
      const existing = findArtifactByExternal.get('local', externalId) as { id: string } | undefined
      if (existing) return
      const artifactId = randomUUID()
      const title = `${row.title} (${type})`
      const mimeType = type === 'recording' ? 'video/mp4' : 'text/markdown'
      insertArtifact.run(
        artifactId,
        null,
        null,
        row.id,
        type,
        title,
        mimeType,
        storageUri,
        'local',
        externalId,
        '',
        row.date
      )
      insertArtifactFts.run(artifactId, title, '')
    }

    seedArtifact('transcript', row.transcript_path)
    seedArtifact('summary', row.summary_path)
    seedArtifact('recording', row.recording_path)
  }

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(BACKFILL_KEY)
}
