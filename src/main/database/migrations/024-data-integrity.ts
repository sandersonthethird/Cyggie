import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_024_data_integrity_v1'

const COMMON_SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu'])

interface CompanySeedRow {
  id: string
  canonical_name: string
  primary_domain: string | null
  website_url: string | null
}

function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!cleaned) return null
  return cleaned.replace(/^www\./, '')
}

function getRegistrableDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')

  const last = labels[labels.length - 1]
  const secondLast = labels[labels.length - 2]
  if (last.length === 2 && COMMON_SECOND_LEVEL_TLDS.has(secondLast) && labels.length >= 3) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

function buildDomainCandidates(domain: string): string[] {
  const normalized = normalizeDomain(domain)
  if (!normalized) return []
  const registrable = getRegistrableDomain(normalized)
  return [...new Set([normalized, registrable, `www.${registrable}`])]
}

function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function extractDomainFromEmail(email: string): string | null {
  const match = email.trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/)
  if (!match?.[1]) return null
  return normalizeDomain(match[1])
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined
  return Boolean(row?.name)
}

function createConfidenceTriggers(
  db: Database.Database,
  tableName: string,
  columnName: string,
  allowNull = false
): void {
  if (!tableExists(db, tableName)) return

  const clause = allowNull
    ? `NEW.${columnName} IS NOT NULL AND (NEW.${columnName} < 0 OR NEW.${columnName} > 1)`
    : `NEW.${columnName} < 0 OR NEW.${columnName} > 1`

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${tableName}_${columnName}_check_insert
    BEFORE INSERT ON ${tableName}
    WHEN ${clause}
    BEGIN
      SELECT RAISE(FAIL, '${tableName}.${columnName} must be between 0 and 1');
    END;
  `)

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_${tableName}_${columnName}_check_update
    BEFORE UPDATE OF ${columnName} ON ${tableName}
    WHEN ${clause}
    BEGIN
      SELECT RAISE(FAIL, '${tableName}.${columnName} must be between 0 and 1');
    END;
  `)
}

function resolveCompanyIdByDomain(
  byPrimaryDomain: Database.Statement,
  byDomainAlias: Database.Statement,
  emailDomain: string
): string | null {
  const candidates = buildDomainCandidates(emailDomain)
  for (const candidate of candidates) {
    const byPrimary = byPrimaryDomain.get(candidate, candidate) as { id: string } | undefined
    if (byPrimary?.id) return byPrimary.id

    const byAlias = byDomainAlias.get(candidate) as { company_id: string } | undefined
    if (byAlias?.company_id) return byAlias.company_id
  }
  return null
}

function resolveCompanyIdByNameOrDomain(
  byNormalizedName: Database.Statement,
  byNameAlias: Database.Statement,
  byPrimaryDomain: Database.Statement,
  byDomainAlias: Database.Statement,
  companyName: string,
  candidateDomains: string[]
): string | null {
  const normalizedName = normalizeCompanyName(companyName)
  if (normalizedName) {
    const byName = byNormalizedName.get(normalizedName) as { id: string } | undefined
    if (byName?.id) return byName.id

    const aliasByName = byNameAlias.get(companyName.trim()) as { company_id: string } | undefined
    if (aliasByName?.company_id) return aliasByName.company_id
  }

  for (const domain of candidateDomains) {
    const byDomain = resolveCompanyIdByDomain(byPrimaryDomain, byDomainAlias, domain)
    if (byDomain) return byDomain
  }

  return null
}

export function runDataIntegrityMigration(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_company_aliases_type_value
      ON org_company_aliases(alias_type, alias_value COLLATE NOCASE);
  `)

  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MIGRATION_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  if (tableExists(db, 'contact_emails')) {
    db.exec(`
      UPDATE contact_emails
      SET is_primary = 0;
    `)

    db.exec(`
      WITH ranked AS (
        SELECT
          ce.rowid AS rid,
          ROW_NUMBER() OVER (
            PARTITION BY ce.contact_id
            ORDER BY
              CASE
                WHEN lower(trim(ce.email)) = lower(trim(COALESCE(c.email, ''))) THEN 0
                WHEN ce.is_primary = 1 THEN 1
                ELSE 2
              END,
              datetime(ce.created_at) ASC,
              ce.email ASC
          ) AS rn
        FROM contact_emails ce
        LEFT JOIN contacts c ON c.id = ce.contact_id
      )
      UPDATE contact_emails
      SET is_primary = 1
      WHERE rowid IN (SELECT rid FROM ranked WHERE rn = 1);
    `)

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_emails_single_primary
        ON contact_emails(contact_id)
        WHERE is_primary = 1;
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_contact_emails_primary_insert
      AFTER INSERT ON contact_emails
      WHEN NEW.is_primary = 1
      BEGIN
        UPDATE contact_emails
        SET is_primary = 0
        WHERE contact_id = NEW.contact_id AND email <> NEW.email;

        UPDATE contacts
        SET email = NEW.email, updated_at = datetime('now')
        WHERE id = NEW.contact_id;
      END;
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_contact_emails_primary_update
      AFTER UPDATE OF is_primary, email ON contact_emails
      WHEN NEW.is_primary = 1
      BEGIN
        UPDATE contact_emails
        SET is_primary = 0
        WHERE contact_id = NEW.contact_id AND email <> NEW.email;

        UPDATE contacts
        SET email = NEW.email, updated_at = datetime('now')
        WHERE id = NEW.contact_id;
      END;
    `)

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_contact_emails_primary_delete
      AFTER DELETE ON contact_emails
      WHEN OLD.is_primary = 1
      BEGIN
        UPDATE contact_emails
        SET is_primary = 1
        WHERE rowid = (
          SELECT rowid
          FROM contact_emails
          WHERE contact_id = OLD.contact_id
          ORDER BY datetime(created_at) ASC, email ASC
          LIMIT 1
        );

        UPDATE contacts
        SET
          email = (
            SELECT email
            FROM contact_emails
            WHERE contact_id = OLD.contact_id
            ORDER BY is_primary DESC, datetime(created_at) ASC, email ASC
            LIMIT 1
          ),
          updated_at = datetime('now')
        WHERE id = OLD.contact_id;
      END;
    `)
  }

  createConfidenceTriggers(db, 'meeting_company_links', 'confidence')
  createConfidenceTriggers(db, 'meeting_theme_links', 'confidence')
  createConfidenceTriggers(db, 'email_company_links', 'confidence')
  createConfidenceTriggers(db, 'email_contact_links', 'confidence')
  createConfidenceTriggers(db, 'email_theme_links', 'confidence')
  createConfidenceTriggers(db, 'org_company_industries', 'confidence')
  createConfidenceTriggers(db, 'org_company_themes', 'relevance_score')
  createConfidenceTriggers(db, 'thesis_claims', 'confidence', true)
  createConfidenceTriggers(db, 'org_companies', 'classification_confidence', true)

  const companyRows = db
    .prepare(`
      SELECT id, canonical_name, primary_domain, website_url
      FROM org_companies
    `)
    .all() as CompanySeedRow[]

  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO org_company_aliases (
      id, company_id, alias_value, alias_type, created_at
    ) VALUES (?, ?, ?, ?, datetime('now'))
  `)

  const selectCachedDisplayNames = tableExists(db, 'companies')
    ? db.prepare(`
      SELECT display_name
      FROM companies
      WHERE domain = ?
        AND display_name IS NOT NULL
        AND TRIM(display_name) <> ''
    `)
    : null

  for (const row of companyRows) {
    const nameAlias = row.canonical_name.trim()
    if (nameAlias) {
      insertAlias.run(randomUUID(), row.id, nameAlias, 'name')
    }

    const domainVariants = new Set<string>()
    const primaryDomain = normalizeDomain(row.primary_domain)
    if (primaryDomain) {
      for (const domain of buildDomainCandidates(primaryDomain)) {
        domainVariants.add(domain)
      }
    }

    const websiteDomain = normalizeDomain(row.website_url)
    if (websiteDomain) {
      for (const domain of buildDomainCandidates(websiteDomain)) {
        domainVariants.add(domain)
      }
    }

    for (const domain of domainVariants) {
      insertAlias.run(randomUUID(), row.id, domain, 'domain')
      if (selectCachedDisplayNames) {
        const cachedRows = selectCachedDisplayNames.all(domain) as Array<{ display_name: string }>
        for (const cached of cachedRows) {
          const aliasName = (cached.display_name || '').trim()
          if (aliasName) {
            insertAlias.run(randomUUID(), row.id, aliasName, 'name')
          }
        }
      }
    }
  }

  const findByNormalizedName = db.prepare(`
    SELECT id
    FROM org_companies
    WHERE normalized_name = ?
    LIMIT 1
  `)
  const findByNameAlias = db.prepare(`
    SELECT company_id
    FROM org_company_aliases
    WHERE alias_type = 'name'
      AND lower(trim(alias_value)) = lower(trim(?))
    LIMIT 1
  `)
  const findByPrimaryDomain = db.prepare(`
    SELECT id
    FROM org_companies
    WHERE lower(trim(primary_domain)) = ?
       OR (
         CASE
           WHEN lower(trim(primary_domain)) LIKE 'www.%' THEN substr(lower(trim(primary_domain)), 5)
           ELSE lower(trim(primary_domain))
         END
       ) = ?
    LIMIT 1
  `)
  const findByDomainAlias = db.prepare(`
    SELECT company_id
    FROM org_company_aliases
    WHERE alias_type = 'domain'
      AND lower(trim(alias_value)) = lower(trim(?))
    LIMIT 1
  `)
  const insertCompany = db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, primary_domain, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `)
  const upsertMeetingCompanyLink = db.prepare(`
    INSERT INTO meeting_company_links (
      meeting_id, company_id, confidence, linked_by, created_at
    )
    VALUES (?, ?, ?, 'backfill', datetime('now'))
    ON CONFLICT(meeting_id, company_id) DO UPDATE SET
      confidence = CASE
        WHEN excluded.confidence > meeting_company_links.confidence THEN excluded.confidence
        ELSE meeting_company_links.confidence
      END,
      linked_by = excluded.linked_by
  `)

  const meetingRows = db
    .prepare(`
      SELECT id, companies, attendee_emails
      FROM meetings
      WHERE companies IS NOT NULL
    `)
    .all() as Array<{
    id: string
    companies: string | null
    attendee_emails: string | null
  }>

  for (const row of meetingRows) {
    const names = parseJsonArray(row.companies)
      .map((name) => name.trim())
      .filter((name) => Boolean(name))
    if (names.length === 0) continue

    const domains = parseJsonArray(row.attendee_emails)
      .map((email) => extractDomainFromEmail(email))
      .filter((domain): domain is string => Boolean(domain))

    for (const name of names) {
      let companyId = resolveCompanyIdByNameOrDomain(
        findByNormalizedName,
        findByNameAlias,
        findByPrimaryDomain,
        findByDomainAlias,
        name,
        domains
      )

      if (!companyId) {
        companyId = randomUUID()
        const normalizedName = normalizeCompanyName(name)
        const registrableDomain = domains[0] ? getRegistrableDomain(domains[0]) : null
        insertCompany.run(companyId, name, normalizedName, registrableDomain)
      }

      insertAlias.run(randomUUID(), companyId, name, 'name')
      const domainForAlias = domains[0] ? getRegistrableDomain(domains[0]) : null
      if (domainForAlias) {
        for (const candidate of buildDomainCandidates(domainForAlias)) {
          insertAlias.run(randomUUID(), companyId, candidate, 'domain')
        }
      }

      upsertMeetingCompanyLink.run(row.id, companyId, 0.7)
    }
  }

  const linkContactCompany = db.prepare(`
    INSERT OR IGNORE INTO org_company_contacts (
      company_id, contact_id, is_primary, created_at
    ) VALUES (?, ?, 1, datetime('now'))
  `)
  const setContactPrimaryCompany = db.prepare(`
    UPDATE contacts
    SET primary_company_id = ?, updated_at = datetime('now')
    WHERE id = ? AND primary_company_id IS NULL
  `)
  const contactRows = db
    .prepare(`
      SELECT id, email
      FROM contacts
      WHERE primary_company_id IS NULL
    `)
    .all() as Array<{ id: string; email: string | null }>
  const listContactEmails = db.prepare(`
    SELECT email
    FROM contact_emails
    WHERE contact_id = ?
    ORDER BY is_primary DESC, datetime(created_at) ASC, email ASC
  `)

  for (const row of contactRows) {
    const emailCandidates = new Set<string>()
    if (row.email) emailCandidates.add(row.email)
    const secondary = listContactEmails.all(row.id) as Array<{ email: string }>
    for (const item of secondary) {
      emailCandidates.add(item.email)
    }

    let matchedCompanyId: string | null = null
    for (const email of emailCandidates) {
      const domain = extractDomainFromEmail(email)
      if (!domain) continue
      matchedCompanyId = resolveCompanyIdByDomain(findByPrimaryDomain, findByDomainAlias, domain)
      if (matchedCompanyId) break
    }

    if (!matchedCompanyId) continue
    const result = setContactPrimaryCompany.run(matchedCompanyId, row.id)
    if (result.changes > 0) {
      linkContactCompany.run(matchedCompanyId, row.id)
    }
  }

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(MIGRATION_KEY)
}
