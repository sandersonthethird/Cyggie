import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type {
  CompanyEntityType,
  CompanyPriority,
  CompanyRound,
  CompanyPipelineStage,
  CompanyListFilter,
  CompanySummary,
  CompanyDetail,
  CompanyMeetingRef,
  CompanyContactRef,
  CompanyEmailRef,
  CompanyFileRef,
  CompanyTimelineItem
} from '../../../shared/types/company'

interface CompanyRow {
  id: string
  canonical_name: string
  normalized_name: string
  description: string | null
  primary_domain: string | null
  website_url: string | null
  city: string | null
  state: string | null
  stage: string | null
  status: string
  crm_provider: string | null
  crm_company_id: string | null
  entity_type: CompanyEntityType
  include_in_companies_view: number
  classification_source: 'manual' | 'auto'
  classification_confidence: number | null
  meeting_count: number
  email_count: number
  note_count: number
  priority: string | null
  post_money_valuation: number | null
  raise_size: number | null
  round: string | null
  pipeline_stage: string | null
  last_touchpoint: string | null
  created_at: string
  updated_at: string
}

export interface CompanyMergeResult {
  targetCompanyId: string
  sourceCompanyId: string
  relinked: {
    meetingLinks: number
    emailLinks: number
    contactPrimaries: number
    contactLinks: number
    deals: number
    notes: number
    conversations: number
    memos: number
    industries: number
    themes: number
    theses: number
    artifacts: number
    aliases: number
  }
}

function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

const COMMON_SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu'])

function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null
  const cleaned = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!cleaned) return null
  return cleaned.replace(/^www\./, '')
}

function getRegistrableDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')

  const tld = labels[labels.length - 1]
  const secondLevel = labels[labels.length - 2]
  if (tld.length === 2 && COMMON_SECOND_LEVEL_TLDS.has(secondLevel) && labels.length >= 3) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

function getDomainLookupCandidates(domain: string): string[] {
  const normalized = normalizeDomain(domain)
  if (!normalized) return []
  const registrable = getRegistrableDomain(normalized)
  return [...new Set([normalized, registrable, `www.${registrable}`])]
}

function upsertCompanyAlias(
  db: ReturnType<typeof getDatabase>,
  companyId: string,
  aliasValue: string | null | undefined,
  aliasType: 'name' | 'domain'
): void {
  const normalizedAlias = aliasType === 'domain'
    ? normalizeDomain(aliasValue || '')
    : (aliasValue || '').trim()
  if (!normalizedAlias) return

  db.prepare(`
    INSERT OR IGNORE INTO org_company_aliases (
      id, company_id, alias_value, alias_type, created_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(randomUUID(), companyId, normalizedAlias, aliasType)
}

function normalizeEntityType(value: string | null | undefined): CompanyEntityType {
  const normalized = (value || '').trim().toLowerCase()
  const allowed: CompanyEntityType[] = [
    'prospect',
    'portfolio',
    'pass',
    'vc_fund',
    'customer',
    'partner',
    'vendor',
    'other',
    'unknown'
  ]
  return allowed.includes(normalized as CompanyEntityType)
    ? (normalized as CompanyEntityType)
    : 'unknown'
}

function parseEmailParticipants(value: string | null): CompanyEmailRef['participants'] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []

    const allowedRoles = new Set(['from', 'to', 'cc', 'bcc', 'reply_to'])
    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const candidate = item as Record<string, unknown>
        const role = typeof candidate.role === 'string' ? candidate.role.trim().toLowerCase() : ''
        const email = typeof candidate.email === 'string' ? candidate.email.trim().toLowerCase() : ''
        if (!allowedRoles.has(role) || !email) return null
        return {
          role: role as CompanyEmailRef['participants'][number]['role'],
          email,
          displayName: typeof candidate.displayName === 'string'
            ? candidate.displayName.trim() || null
            : null,
          contactId: typeof candidate.contactId === 'string'
            ? candidate.contactId.trim() || null
            : null
        }
      })
      .filter((item): item is CompanyEmailRef['participants'][number] => Boolean(item))
  } catch {
    return []
  }
}

function rowToCompanySummary(row: CompanyRow): CompanySummary {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    normalizedName: row.normalized_name,
    description: row.description,
    primaryDomain: row.primary_domain,
    websiteUrl: row.website_url,
    city: row.city,
    state: row.state,
    stage: row.stage,
    status: row.status,
    crmProvider: row.crm_provider,
    crmCompanyId: row.crm_company_id,
    entityType: normalizeEntityType(row.entity_type),
    includeInCompaniesView: row.include_in_companies_view === 1,
    classificationSource: row.classification_source === 'manual' ? 'manual' : 'auto',
    classificationConfidence: row.classification_confidence,
    meetingCount: row.meeting_count || 0,
    emailCount: row.email_count || 0,
    noteCount: row.note_count || 0,
    priority: (row.priority as CompanyPriority) || null,
    postMoneyValuation: row.post_money_valuation,
    raiseSize: row.raise_size,
    round: (row.round as CompanyRound) || null,
    pipelineStage: (row.pipeline_stage as CompanyPipelineStage) || null,
    lastTouchpoint: row.last_touchpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function baseCompanySelect(whereClause = ''): string {
  return `
    SELECT
      c.id,
      c.canonical_name,
      c.normalized_name,
      c.description,
      c.primary_domain,
      c.website_url,
      c.city,
      c.state,
      c.stage,
      c.status,
      c.crm_provider,
      c.crm_company_id,
      c.entity_type,
      c.include_in_companies_view,
      c.classification_source,
      c.classification_confidence,
      c.priority,
      c.post_money_valuation,
      c.raise_size,
      c.round,
      c.pipeline_stage,
      COALESCE(mc.meeting_count, 0) AS meeting_count,
      COALESCE(ec.email_count, 0) AS email_count,
      COALESCE(nc.note_count, 0) AS note_count,
      COALESCE(
        CASE
          WHEN mc.last_meeting_at IS NULL THEN ec.last_email_at
          WHEN ec.last_email_at IS NULL THEN mc.last_meeting_at
          WHEN mc.last_meeting_at > ec.last_email_at THEN mc.last_meeting_at
          ELSE ec.last_email_at
        END,
        c.updated_at
      ) AS last_touchpoint,
      c.created_at,
      c.updated_at
    FROM org_companies c
    LEFT JOIN (
      SELECT
        l.company_id,
        COUNT(DISTINCT l.meeting_id) AS meeting_count,
        MAX(m.date) AS last_meeting_at
      FROM meeting_company_links l
      JOIN meetings m ON m.id = l.meeting_id
      GROUP BY l.company_id
    ) mc ON mc.company_id = c.id
    LEFT JOIN (
      SELECT
        l.company_id,
        COUNT(DISTINCT l.message_id) AS email_count,
        MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
      FROM email_company_links l
      JOIN email_messages em ON em.id = l.message_id
      GROUP BY l.company_id
    ) ec ON ec.company_id = c.id
    LEFT JOIN (
      SELECT company_id, COUNT(*) AS note_count
      FROM company_notes
      GROUP BY company_id
    ) nc ON nc.company_id = c.id
    ${whereClause}
  `
}

function baseCompanySelectLight(whereClause = ''): string {
  return `
    SELECT
      c.id,
      c.canonical_name,
      c.normalized_name,
      c.description,
      c.primary_domain,
      c.website_url,
      c.city,
      c.state,
      c.stage,
      c.status,
      c.crm_provider,
      c.crm_company_id,
      c.entity_type,
      c.include_in_companies_view,
      c.classification_source,
      c.classification_confidence,
      c.priority,
      c.post_money_valuation,
      c.raise_size,
      c.round,
      c.pipeline_stage,
      0 AS meeting_count,
      0 AS email_count,
      0 AS note_count,
      c.updated_at AS last_touchpoint,
      c.created_at,
      c.updated_at
    FROM org_companies c
    ${whereClause}
  `
}

export function listCompanies(filter?: CompanyListFilter): CompanySummary[] {
  const db = getDatabase()
  const query = filter?.query?.trim()
  const view = filter?.view ?? 'companies'
  const conditions: string[] = []
  const params: unknown[] = []

  if (view !== 'all') {
    conditions.push('c.include_in_companies_view = 1')
  }

  if (query) {
    conditions.push('(c.canonical_name LIKE ? OR c.primary_domain LIKE ? OR c.description LIKE ?)')
    const like = `%${query}%`
    params.push(like, like, like)
  }

  if (filter?.entityTypes && filter.entityTypes.length > 0) {
    const normalizedEntityTypes = [...new Set(filter.entityTypes.map(normalizeEntityType))]
    const placeholders = normalizedEntityTypes.map(() => '?').join(', ')
    conditions.push(`c.entity_type IN (${placeholders})`)
    params.push(...normalizedEntityTypes)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filter?.limit ?? 200
  const offset = filter?.offset ?? 0

  const rows = db
    .prepare(
      `${baseCompanySelectLight(where)}
       ORDER BY datetime(c.updated_at) DESC, c.canonical_name ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as CompanyRow[]

  return rows.map(rowToCompanySummary)
}

export function listPipelineCompanies(filter?: {
  pipelineStage?: CompanyPipelineStage | null
  priority?: CompanyPriority | null
  round?: CompanyRound | null
  query?: string
}): CompanySummary[] {
  const db = getDatabase()
  const conditions: string[] = ['c.pipeline_stage IS NOT NULL']
  const params: unknown[] = []

  if (filter?.pipelineStage) {
    conditions.push('c.pipeline_stage = ?')
    params.push(filter.pipelineStage)
  }
  if (filter?.priority) {
    conditions.push('c.priority = ?')
    params.push(filter.priority)
  }
  if (filter?.round) {
    conditions.push('c.round = ?')
    params.push(filter.round)
  }
  if (filter?.query?.trim()) {
    conditions.push('(c.canonical_name LIKE ? OR c.description LIKE ?)')
    const like = `%${filter.query.trim()}%`
    params.push(like, like)
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const rows = db
    .prepare(
      `${baseCompanySelect(where)}
       ORDER BY
         CASE c.pipeline_stage
           WHEN 'screening' THEN 0
           WHEN 'diligence' THEN 1
           WHEN 'decision' THEN 2
           WHEN 'documentation' THEN 3
           WHEN 'pass' THEN 4
           ELSE 5
         END,
         CASE c.priority
           WHEN 'high' THEN 0
           WHEN 'further_work' THEN 1
           WHEN 'monitor' THEN 2
           ELSE 3
         END,
         c.canonical_name ASC
       LIMIT 500`
    )
    .all(...params) as CompanyRow[]

  return rows.map(rowToCompanySummary)
}

export function getCompany(companyId: string): CompanyDetail | null {
  const db = getDatabase()
  const row = db
    .prepare(`${baseCompanySelect('WHERE c.id = ?')} LIMIT 1`)
    .get(companyId) as CompanyRow | undefined
  if (!row) return null

  const industries = db
    .prepare(`
      SELECT i.name
      FROM org_company_industries ci
      JOIN industries i ON i.id = ci.industry_id
      WHERE ci.company_id = ?
      ORDER BY ci.is_primary DESC, i.name ASC
    `)
    .all(companyId) as { name: string }[]

  const themes = db
    .prepare(`
      SELECT t.name
      FROM org_company_themes ct
      JOIN themes t ON t.id = ct.theme_id
      WHERE ct.company_id = ?
      ORDER BY ct.relevance_score DESC, t.name ASC
    `)
    .all(companyId) as { name: string }[]

  return {
    ...rowToCompanySummary(row),
    industries: industries.map((v) => v.name),
    themes: themes.map((v) => v.name)
  }
}

export function createCompany(data: {
  canonicalName: string
  description?: string | null
  primaryDomain?: string | null
  websiteUrl?: string | null
  city?: string | null
  state?: string | null
  stage?: string | null
  status?: string
  entityType?: CompanyEntityType
  includeInCompaniesView?: boolean
  classificationSource?: 'manual' | 'auto'
  classificationConfidence?: number | null
}, userId: string | null = null): CompanyDetail {
  const db = getDatabase()
  const canonicalName = data.canonicalName.trim()
  const normalizedName = normalizeCompanyName(canonicalName)
  const normalizedPrimaryDomain = normalizeDomain(data.primaryDomain ?? null)
  const entityType = normalizeEntityType(data.entityType ?? 'prospect')
  const includeInCompaniesView = data.includeInCompaniesView ?? (entityType === 'prospect')
  const classificationSource = data.classificationSource ?? 'manual'
  const classificationConfidence =
    data.classificationConfidence === undefined ? 1 : data.classificationConfidence
  const id = randomUUID()

  db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, description, primary_domain, website_url, city, state, stage, status,
      entity_type, include_in_companies_view, classification_source, classification_confidence,
      created_by_user_id, updated_by_user_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(normalized_name) DO UPDATE SET
      canonical_name = excluded.canonical_name,
      description = COALESCE(excluded.description, org_companies.description),
      primary_domain = COALESCE(excluded.primary_domain, org_companies.primary_domain),
      website_url = COALESCE(excluded.website_url, org_companies.website_url),
      city = COALESCE(excluded.city, org_companies.city),
      state = COALESCE(excluded.state, org_companies.state),
      stage = COALESCE(excluded.stage, org_companies.stage),
      status = COALESCE(excluded.status, org_companies.status),
      entity_type = excluded.entity_type,
      include_in_companies_view = excluded.include_in_companies_view,
      classification_source = excluded.classification_source,
      classification_confidence = excluded.classification_confidence,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = datetime('now')
  `).run(
    id,
    canonicalName,
    normalizedName,
    data.description ?? null,
    normalizedPrimaryDomain,
    data.websiteUrl ?? null,
    data.city ?? null,
    data.state ?? null,
    data.stage ?? null,
    data.status ?? 'active',
    entityType,
    includeInCompaniesView ? 1 : 0,
    classificationSource,
    classificationConfidence,
    userId,
    userId
  )

  const row = db
    .prepare('SELECT id FROM org_companies WHERE normalized_name = ?')
    .get(normalizedName) as { id: string } | undefined
  if (!row) {
    throw new Error('Failed to create or load company')
  }

  upsertCompanyAlias(db, row.id, canonicalName, 'name')
  if (normalizedPrimaryDomain) {
    for (const candidate of getDomainLookupCandidates(normalizedPrimaryDomain)) {
      upsertCompanyAlias(db, row.id, candidate, 'domain')
    }
  }

  const detail = getCompany(row.id)
  if (!detail) {
    throw new Error('Failed to load created company')
  }
  return detail
}

export function updateCompany(
  companyId: string,
  data: Partial<{
    canonicalName: string
    description: string | null
    primaryDomain: string | null
    websiteUrl: string | null
    city: string | null
    state: string | null
    stage: string | null
    status: string
    entityType: CompanyEntityType
    includeInCompaniesView: boolean
    classificationSource: 'manual' | 'auto'
    classificationConfidence: number | null
    priority: CompanyPriority | null
    postMoneyValuation: number | null
    raiseSize: number | null
    round: CompanyRound | null
    pipelineStage: CompanyPipelineStage | null
  }>
,
  userId: string | null = null
): CompanyDetail | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []
  let normalizedCanonicalName: string | null = null
  let normalizedPrimaryDomain: string | null = null

  if (data.canonicalName !== undefined) {
    normalizedCanonicalName = data.canonicalName.trim()
    sets.push('canonical_name = ?')
    params.push(normalizedCanonicalName)
    sets.push('normalized_name = ?')
    params.push(normalizeCompanyName(data.canonicalName))
  }
  if (data.description !== undefined) {
    sets.push('description = ?')
    params.push(data.description)
  }
  if (data.primaryDomain !== undefined) {
    normalizedPrimaryDomain = normalizeDomain(data.primaryDomain)
    sets.push('primary_domain = ?')
    params.push(normalizedPrimaryDomain)
  }
  if (data.websiteUrl !== undefined) {
    sets.push('website_url = ?')
    params.push(data.websiteUrl)
  }
  if (data.city !== undefined) {
    sets.push('city = ?')
    params.push(data.city)
  }
  if (data.state !== undefined) {
    sets.push('state = ?')
    params.push(data.state)
  }
  if (data.stage !== undefined) {
    sets.push('stage = ?')
    params.push(data.stage)
  }
  if (data.status !== undefined) {
    sets.push('status = ?')
    params.push(data.status)
  }
  if (data.entityType !== undefined) {
    const normalizedEntityType = normalizeEntityType(data.entityType)
    sets.push('entity_type = ?')
    params.push(normalizedEntityType)

    // Keep include_in_companies_view aligned with classification when callers
    // only update entityType (common from the Company Detail type control).
    if (data.includeInCompaniesView === undefined) {
      sets.push('include_in_companies_view = ?')
      params.push(normalizedEntityType === 'prospect' ? 1 : 0)
    }
  }
  if (data.includeInCompaniesView !== undefined) {
    sets.push('include_in_companies_view = ?')
    params.push(data.includeInCompaniesView ? 1 : 0)
  }
  if (data.classificationSource !== undefined) {
    sets.push('classification_source = ?')
    params.push(data.classificationSource)
  }
  if (data.classificationConfidence !== undefined) {
    sets.push('classification_confidence = ?')
    params.push(data.classificationConfidence)
  }
  if (data.priority !== undefined) {
    sets.push('priority = ?')
    params.push(data.priority)
  }
  if (data.postMoneyValuation !== undefined) {
    sets.push('post_money_valuation = ?')
    params.push(data.postMoneyValuation)
  }
  if (data.raiseSize !== undefined) {
    sets.push('raise_size = ?')
    params.push(data.raiseSize)
  }
  if (data.round !== undefined) {
    sets.push('round = ?')
    params.push(data.round)
  }
  if (data.pipelineStage !== undefined) {
    sets.push('pipeline_stage = ?')
    params.push(data.pipelineStage)
  }

  if (sets.length > 0) {
    if (userId) {
      sets.push('updated_by_user_id = ?')
      params.push(userId)
    }
    sets.push("updated_at = datetime('now')")
    params.push(companyId)
    db.prepare(`UPDATE org_companies SET ${sets.join(', ')} WHERE id = ?`).run(...params)

    if (normalizedCanonicalName) {
      upsertCompanyAlias(db, companyId, normalizedCanonicalName, 'name')
    }
    if (data.primaryDomain !== undefined && normalizedPrimaryDomain) {
      for (const candidate of getDomainLookupCandidates(normalizedPrimaryDomain)) {
        upsertCompanyAlias(db, companyId, candidate, 'domain')
      }
    }
  }

  return getCompany(companyId)
}

export function findCompanyIdByDomain(domain: string): string | null {
  const db = getDatabase()
  const domainCandidates = getDomainLookupCandidates(domain)
  if (domainCandidates.length === 0) return null

  const findByPrimaryDomain = db.prepare(`
    SELECT id
    FROM org_companies
    WHERE
      lower(trim(primary_domain)) = ?
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

  for (const candidate of domainCandidates) {
    const byPrimary = findByPrimaryDomain.get(candidate, candidate) as { id: string } | undefined
    if (byPrimary?.id) return byPrimary.id

    const byAlias = findByDomainAlias.get(candidate) as { company_id: string } | undefined
    if (byAlias?.company_id) return byAlias.company_id
  }

  return null
}

export function findCompanyIdByNameOrDomain(
  canonicalName: string,
  primaryDomain?: string | null
): string | null {
  const db = getDatabase()
  const trimmedName = canonicalName.trim()
  const normalizedName = normalizeCompanyName(trimmedName)

  if (normalizedName) {
    const byName = db
      .prepare('SELECT id FROM org_companies WHERE normalized_name = ?')
      .get(normalizedName) as { id: string } | undefined
    if (byName?.id) return byName.id

    const byNameAlias = db
      .prepare(`
        SELECT company_id
        FROM org_company_aliases
        WHERE alias_type = 'name'
          AND lower(trim(alias_value)) = lower(trim(?))
        LIMIT 1
      `)
      .get(trimmedName) as { company_id: string } | undefined
    if (byNameAlias?.company_id) return byNameAlias.company_id
  }

  const normalizedDomain = normalizeDomain(primaryDomain)
  if (!normalizedDomain) return null
  return findCompanyIdByDomain(normalizedDomain)
}

export function getOrCreateCompanyByName(
  canonicalName: string,
  userId: string | null = null
): CompanyDetail {
  const companyName = canonicalName.trim()
  if (!companyName) {
    throw new Error('Company name is required')
  }

  const existingId = findCompanyIdByNameOrDomain(companyName, null)
  if (existingId) {
    const existing = getCompany(existingId)
    if (!existing) {
      throw new Error('Company not found')
    }
    return existing
  }

  return createCompany({
    canonicalName: companyName,
    entityType: 'prospect',
    includeInCompaniesView: true,
    classificationSource: 'manual',
    classificationConfidence: 1
  }, userId)
}

export function getEntityTypeByNameOrDomain(
  canonicalName: string,
  primaryDomain?: string | null
): CompanyEntityType | null {
  const companyId = findCompanyIdByNameOrDomain(canonicalName, primaryDomain)
  if (!companyId) return null

  const company = getCompany(companyId)
  if (!company || company.entityType === 'unknown') return null
  return company.entityType
}

export function upsertCompanyClassification(data: {
  canonicalName: string
  primaryDomain?: string | null
  entityType: CompanyEntityType
  includeInCompaniesView?: boolean
  classificationSource?: 'manual' | 'auto'
  classificationConfidence?: number | null
}, userId: string | null = null): CompanyDetail {
  const companyName = data.canonicalName.trim()
  if (!companyName) {
    throw new Error('Company name is required')
  }

  const existingId = findCompanyIdByNameOrDomain(companyName, data.primaryDomain ?? null)
  const entityType = normalizeEntityType(data.entityType)
  const includeInCompaniesView = data.includeInCompaniesView ?? (entityType === 'prospect')
  const classificationSource = data.classificationSource ?? 'manual'
  const classificationConfidence =
    data.classificationConfidence === undefined ? 1 : data.classificationConfidence

  if (!existingId) {
    return createCompany({
      canonicalName: companyName,
      primaryDomain: data.primaryDomain ?? null,
      entityType,
      includeInCompaniesView,
      classificationSource,
      classificationConfidence
    }, userId)
  }

  const existing = getCompany(existingId)
  if (!existing) {
    throw new Error('Company not found')
  }

  const candidateDomain = normalizeDomain(data.primaryDomain ?? null)
  const shouldSetDomain =
    Boolean(candidateDomain)
    && (!existing.primaryDomain || existing.primaryDomain === candidateDomain)

  const updated = updateCompany(existingId, {
    canonicalName: companyName,
    primaryDomain: shouldSetDomain ? candidateDomain : existing.primaryDomain,
    entityType,
    includeInCompaniesView,
    classificationSource,
    classificationConfidence
  }, userId)
  if (!updated) {
    throw new Error('Failed to update company classification')
  }
  return updated
}

export function mergeCompanies(targetCompanyId: string, sourceCompanyId: string): CompanyMergeResult {
  if (!targetCompanyId || !sourceCompanyId) {
    throw new Error('Both targetCompanyId and sourceCompanyId are required')
  }
  if (targetCompanyId === sourceCompanyId) {
    throw new Error('Target and source companies must be different')
  }

  const db = getDatabase()
  const target = db
    .prepare('SELECT id FROM org_companies WHERE id = ? LIMIT 1')
    .get(targetCompanyId) as { id: string } | undefined
  const source = db
    .prepare('SELECT id FROM org_companies WHERE id = ? LIMIT 1')
    .get(sourceCompanyId) as { id: string } | undefined

  if (!target) throw new Error('Target company not found')
  if (!source) throw new Error('Source company not found')

  const relinked = {
    meetingLinks: 0,
    emailLinks: 0,
    contactPrimaries: 0,
    contactLinks: 0,
    deals: 0,
    notes: 0,
    conversations: 0,
    memos: 0,
    industries: 0,
    themes: 0,
    theses: 0,
    artifacts: 0,
    aliases: 0
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO meeting_company_links (
        meeting_id, company_id, confidence, linked_by, created_at
      )
      SELECT meeting_id, ?, confidence, linked_by, created_at
      FROM meeting_company_links
      WHERE company_id = ?
      ON CONFLICT(meeting_id, company_id) DO UPDATE SET
        confidence = CASE
          WHEN excluded.confidence > meeting_company_links.confidence THEN excluded.confidence
          ELSE meeting_company_links.confidence
        END,
        linked_by = excluded.linked_by
    `).run(targetCompanyId, sourceCompanyId)
    relinked.meetingLinks = db
      .prepare('DELETE FROM meeting_company_links WHERE company_id = ?')
      .run(sourceCompanyId).changes

    db.prepare(`
      INSERT INTO email_company_links (
        message_id, company_id, confidence, linked_by, reason, created_at
      )
      SELECT message_id, ?, confidence, linked_by, reason, created_at
      FROM email_company_links
      WHERE company_id = ?
      ON CONFLICT(message_id, company_id) DO UPDATE SET
        confidence = CASE
          WHEN excluded.confidence > email_company_links.confidence THEN excluded.confidence
          ELSE email_company_links.confidence
        END,
        linked_by = excluded.linked_by,
        reason = COALESCE(excluded.reason, email_company_links.reason)
    `).run(targetCompanyId, sourceCompanyId)
    relinked.emailLinks = db
      .prepare('DELETE FROM email_company_links WHERE company_id = ?')
      .run(sourceCompanyId).changes

    relinked.contactPrimaries = db
      .prepare(`
        UPDATE contacts
        SET primary_company_id = ?, updated_at = datetime('now')
        WHERE primary_company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    db.prepare(`
      INSERT OR IGNORE INTO org_company_contacts (
        company_id, contact_id, role_label, is_primary, created_at
      )
      SELECT ?, contact_id, role_label, is_primary, created_at
      FROM org_company_contacts
      WHERE company_id = ?
    `).run(targetCompanyId, sourceCompanyId)
    relinked.contactLinks = db
      .prepare('DELETE FROM org_company_contacts WHERE company_id = ?')
      .run(sourceCompanyId).changes

    relinked.deals = db
      .prepare(`
        UPDATE deals
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    relinked.notes = db
      .prepare(`
        UPDATE company_notes
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    relinked.conversations = db
      .prepare(`
        UPDATE company_conversations
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    relinked.memos = db
      .prepare(`
        UPDATE investment_memos
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    db.prepare(`
      INSERT OR IGNORE INTO org_company_industries (
        company_id, industry_id, confidence, is_primary, tagged_by, created_at
      )
      SELECT ?, industry_id, confidence, is_primary, tagged_by, created_at
      FROM org_company_industries
      WHERE company_id = ?
    `).run(targetCompanyId, sourceCompanyId)
    relinked.industries = db
      .prepare('DELETE FROM org_company_industries WHERE company_id = ?')
      .run(sourceCompanyId).changes

    db.prepare(`
      INSERT OR IGNORE INTO org_company_themes (
        company_id, theme_id, relevance_score, rationale, linked_by, last_reviewed_at, created_at
      )
      SELECT ?, theme_id, relevance_score, rationale, linked_by, last_reviewed_at, created_at
      FROM org_company_themes
      WHERE company_id = ?
    `).run(targetCompanyId, sourceCompanyId)
    relinked.themes = db
      .prepare('DELETE FROM org_company_themes WHERE company_id = ?')
      .run(sourceCompanyId).changes

    relinked.theses = db
      .prepare(`
        UPDATE theses
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    relinked.artifacts = db
      .prepare(`
        UPDATE artifacts
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    db.prepare(`
      INSERT OR IGNORE INTO org_company_aliases (
        id, company_id, alias_value, alias_type, created_at
      )
      SELECT lower(hex(randomblob(16))), ?, alias_value, alias_type, created_at
      FROM org_company_aliases
      WHERE company_id = ?
    `).run(targetCompanyId, sourceCompanyId)
    relinked.aliases = db
      .prepare('DELETE FROM org_company_aliases WHERE company_id = ?')
      .run(sourceCompanyId).changes

    db.prepare(`
      UPDATE org_companies
      SET updated_at = datetime('now')
      WHERE id = ?
    `).run(targetCompanyId)

    db.prepare('DELETE FROM org_companies WHERE id = ?').run(sourceCompanyId)
  })

  tx()

  return {
    targetCompanyId,
    sourceCompanyId,
    relinked
  }
}

export function linkMeetingCompany(
  meetingId: string,
  companyId: string,
  confidence = 1,
  linkedBy = 'manual',
  userId: string | null = null
): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO meeting_company_links (
      meeting_id, company_id, confidence, linked_by, created_by_user_id, updated_by_user_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(meeting_id, company_id) DO UPDATE SET
      confidence = excluded.confidence,
      linked_by = excluded.linked_by,
      updated_by_user_id = excluded.updated_by_user_id
  `).run(meetingId, companyId, confidence, linkedBy, userId, userId)
}

export function listCompanyMeetings(companyId: string): CompanyMeetingRef[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.date,
        m.status,
        m.duration_seconds
      FROM meeting_company_links l
      JOIN meetings m ON m.id = l.meeting_id
      WHERE l.company_id = ?
      ORDER BY datetime(m.date) DESC
    `)
    .all(companyId) as Array<{
    id: string
    title: string
    date: string
    status: string
    duration_seconds: number | null
  }>

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    date: row.date,
    status: row.status,
    durationSeconds: row.duration_seconds
  }))
}

export function listCompanyContacts(companyId: string): CompanyContactRef[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT
        c.id,
        c.full_name,
        c.email,
        c.title,
        c.updated_at,
        COALESCE(ms.meeting_count, 0) AS meeting_count,
        ms.last_meeting_at
      FROM contacts c
      LEFT JOIN (
        SELECT
          lower(e.value) AS attendee_email,
          COUNT(DISTINCT m.id) AS meeting_count,
          MAX(m.date) AS last_meeting_at
        FROM meetings m
        JOIN json_each(COALESCE(m.attendee_emails, '[]')) e
        GROUP BY lower(e.value)
      ) ms ON ms.attendee_email = lower(c.email)
      WHERE
        c.primary_company_id = ?
        OR EXISTS (
          SELECT 1
          FROM org_company_contacts occ
          WHERE occ.company_id = ? AND occ.contact_id = c.id
        )
      ORDER BY datetime(COALESCE(ms.last_meeting_at, c.updated_at)) DESC, c.full_name ASC
      LIMIT 300
    `)
    .all(companyId, companyId) as Array<{
    id: string
    full_name: string
    email: string | null
    title: string | null
    updated_at: string
    meeting_count: number
    last_meeting_at: string | null
  }>

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    title: row.title,
    meetingCount: row.meeting_count || 0,
    lastInteractedAt: row.last_meeting_at ?? row.updated_at,
    updatedAt: row.updated_at
  }))
}

export function listCompanyEmails(companyId: string): CompanyEmailRef[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      WITH linked AS (
        SELECT
          em.id,
          em.subject,
          em.from_email,
          em.from_name,
          em.received_at,
          em.sent_at,
          em.snippet,
          em.body_text,
          em.is_unread,
          em.thread_id,
          em.updated_at,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS sort_at,
          COALESCE(em.thread_id, em.id) AS thread_group
        FROM email_company_links l
        JOIN email_messages em ON em.id = l.message_id
        WHERE l.company_id = ?
      ),
      ranked AS (
        SELECT
          id,
          subject,
          from_email,
          from_name,
          received_at,
          sent_at,
          snippet,
          body_text,
          is_unread,
          thread_id,
          sort_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_group
            ORDER BY datetime(sort_at) DESC, datetime(updated_at) DESC, id DESC
          ) AS row_num,
          COUNT(*) OVER (PARTITION BY thread_group) AS thread_message_count
        FROM linked
      ),
      participant_rows AS (
        SELECT
          p.message_id,
          p.role,
          LOWER(p.email) AS email,
          COALESCE(NULLIF(TRIM(p.display_name), ''), NULLIF(TRIM(c.full_name), '')) AS display_name,
          p.contact_id
        FROM email_message_participants p
        LEFT JOIN contacts c ON c.id = p.contact_id
      ),
      participants AS (
        SELECT
          source.message_id,
          json_group_array(
            json_object(
              'role', source.role,
              'email', source.email,
              'displayName', source.display_name,
              'contactId', source.contact_id
            )
          ) AS participants_json
        FROM (
          SELECT
            message_id,
            role,
            email,
            display_name,
            contact_id
          FROM participant_rows
          ORDER BY
            message_id,
            CASE role
              WHEN 'from' THEN 0
              WHEN 'to' THEN 1
              WHEN 'cc' THEN 2
              WHEN 'bcc' THEN 3
              WHEN 'reply_to' THEN 4
              ELSE 5
            END,
            email
        ) source
        GROUP BY source.message_id
      )
      SELECT
        ranked.id,
        ranked.subject,
        ranked.from_email,
        ranked.from_name,
        ranked.received_at,
        ranked.sent_at,
        ranked.snippet,
        ranked.body_text,
        ranked.is_unread,
        ranked.thread_id,
        ranked.thread_message_count,
        COALESCE(participants.participants_json, '[]') AS participants_json
      FROM ranked
      LEFT JOIN participants ON participants.message_id = ranked.id
      WHERE ranked.row_num = 1
      ORDER BY datetime(ranked.sort_at) DESC, ranked.id DESC
      LIMIT 200
    `)
    .all(companyId) as Array<{
    id: string
    subject: string | null
    from_email: string
    from_name: string | null
    received_at: string | null
    sent_at: string | null
    snippet: string | null
    body_text: string | null
    is_unread: number
    thread_id: string | null
    thread_message_count: number
    participants_json: string
  }>

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    fromEmail: row.from_email,
    fromName: row.from_name,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    snippet: row.snippet,
    bodyText: row.body_text,
    isUnread: row.is_unread === 1,
    threadId: row.thread_id,
    threadMessageCount: row.thread_message_count || 1,
    participants: parseEmailParticipants(row.participants_json)
  }))
}

export function listCompanyFiles(companyId: string): CompanyFileRef[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT
        m.id,
        m.title,
        m.date,
        m.status,
        CASE
          WHEN m.transcript_path IS NOT NULL AND TRIM(m.transcript_path) <> '' THEN 1
          ELSE 0
        END AS has_transcript,
        CASE
          WHEN m.notes IS NOT NULL AND TRIM(m.notes) <> '' THEN 1
          ELSE 0
        END AS has_notes,
        CASE
          WHEN m.summary_path IS NOT NULL AND TRIM(m.summary_path) <> '' THEN 1
          ELSE 0
        END AS has_summary,
        CASE
          WHEN m.recording_path IS NOT NULL AND TRIM(m.recording_path) <> '' THEN 1
          ELSE 0
        END AS has_recording,
        COALESCE(a.artifact_count, 0) AS artifact_count
      FROM meeting_company_links l
      JOIN meetings m ON m.id = l.meeting_id
      LEFT JOIN (
        SELECT
          meeting_id,
          COUNT(*) AS artifact_count
        FROM artifacts
        WHERE meeting_id IS NOT NULL
        GROUP BY meeting_id
      ) a ON a.meeting_id = m.id
      WHERE
        l.company_id = ?
        AND (
          (m.transcript_path IS NOT NULL AND TRIM(m.transcript_path) <> '')
          OR (m.notes IS NOT NULL AND TRIM(m.notes) <> '')
          OR (m.summary_path IS NOT NULL AND TRIM(m.summary_path) <> '')
          OR (m.recording_path IS NOT NULL AND TRIM(m.recording_path) <> '')
          OR COALESCE(a.artifact_count, 0) > 0
        )
      ORDER BY datetime(m.date) DESC
      LIMIT 400
    `)
    .all(companyId) as Array<{
    id: string
    title: string
    date: string
    status: string
    has_transcript: number
    has_notes: number
    has_summary: number
    has_recording: number
    artifact_count: number
  }>

  return rows.map((row) => ({
    id: row.id,
    meetingId: row.id,
    title: row.title,
    date: row.date,
    status: row.status,
    hasTranscript: row.has_transcript === 1,
    hasNotes: row.has_notes === 1,
    hasSummary: row.has_summary === 1,
    hasRecording: row.has_recording === 1,
    artifactCount: row.artifact_count || 0
  }))
}

export function listCompanyTimeline(companyId: string): CompanyTimelineItem[] {
  const db = getDatabase()

  const meetingItems: CompanyTimelineItem[] = listCompanyMeetings(companyId).map((meeting) => ({
    id: `meeting:${meeting.id}`,
    type: 'meeting',
    title: meeting.title,
    occurredAt: meeting.date,
    subtitle: meeting.status,
    referenceId: meeting.id,
    referenceType: 'meeting'
  }))

  const emailItems: CompanyTimelineItem[] = listCompanyEmails(companyId).map((email) => ({
    id: `email:${email.id}`,
    type: 'email',
    title: email.subject?.trim() || '(no subject)',
    occurredAt: email.receivedAt || email.sentAt || new Date().toISOString(),
    subtitle: email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail,
    referenceId: email.id,
    referenceType: 'email'
  }))

  const noteRows = db
    .prepare(`
      SELECT id, title, content, created_at, updated_at
      FROM company_notes
      WHERE company_id = ?
      ORDER BY datetime(updated_at) DESC
      LIMIT 300
    `)
    .all(companyId) as Array<{
    id: string
    title: string | null
    content: string
    created_at: string
    updated_at: string
  }>
  const noteItems: CompanyTimelineItem[] = noteRows.map((note) => ({
    id: `note:${note.id}`,
    type: 'note',
    title: note.title?.trim() || 'Note',
    occurredAt: note.updated_at || note.created_at,
    subtitle: note.content.trim().slice(0, 220) || null,
    referenceId: note.id,
    referenceType: 'company_note'
  }))

  return [...meetingItems, ...emailItems, ...noteItems].sort((a, b) =>
    new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  )
}
