import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import type {
  CompanyEntityType,
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
  last_touchpoint: string | null
  created_at: string
  updated_at: string
}

function normalizeCompanyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '')
}

function normalizeEntityType(value: string | null | undefined): CompanyEntityType {
  const normalized = (value || '').trim().toLowerCase()
  const allowed: CompanyEntityType[] = [
    'prospect',
    'portfolio',
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
      c.stage,
      c.status,
      c.crm_provider,
      c.crm_company_id,
      c.entity_type,
      c.include_in_companies_view,
      c.classification_source,
      c.classification_confidence,
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
      `${baseCompanySelect(where)}
       ORDER BY datetime(last_touchpoint) DESC, c.canonical_name ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as CompanyRow[]

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
  stage?: string | null
  status?: string
  entityType?: CompanyEntityType
  includeInCompaniesView?: boolean
  classificationSource?: 'manual' | 'auto'
  classificationConfidence?: number | null
}): CompanyDetail {
  const db = getDatabase()
  const canonicalName = data.canonicalName.trim()
  const normalizedName = normalizeCompanyName(canonicalName)
  const entityType = normalizeEntityType(data.entityType ?? 'prospect')
  const includeInCompaniesView = data.includeInCompaniesView ?? (entityType === 'prospect')
  const classificationSource = data.classificationSource ?? 'manual'
  const classificationConfidence =
    data.classificationConfidence === undefined ? 1 : data.classificationConfidence
  const id = randomUUID()

  db.prepare(`
    INSERT INTO org_companies (
      id, canonical_name, normalized_name, description, primary_domain, website_url, stage, status,
      entity_type, include_in_companies_view, classification_source, classification_confidence,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(normalized_name) DO UPDATE SET
      canonical_name = excluded.canonical_name,
      description = COALESCE(excluded.description, org_companies.description),
      primary_domain = COALESCE(excluded.primary_domain, org_companies.primary_domain),
      website_url = COALESCE(excluded.website_url, org_companies.website_url),
      stage = COALESCE(excluded.stage, org_companies.stage),
      status = COALESCE(excluded.status, org_companies.status),
      entity_type = excluded.entity_type,
      include_in_companies_view = excluded.include_in_companies_view,
      classification_source = excluded.classification_source,
      classification_confidence = excluded.classification_confidence,
      updated_at = datetime('now')
  `).run(
    id,
    canonicalName,
    normalizedName,
    data.description ?? null,
    data.primaryDomain ? normalizeDomain(data.primaryDomain) : null,
    data.websiteUrl ?? null,
    data.stage ?? null,
    data.status ?? 'active',
    entityType,
    includeInCompaniesView ? 1 : 0,
    classificationSource,
    classificationConfidence
  )

  const row = db
    .prepare('SELECT id FROM org_companies WHERE normalized_name = ?')
    .get(normalizedName) as { id: string } | undefined
  if (!row) {
    throw new Error('Failed to create or load company')
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
    stage: string | null
    status: string
    entityType: CompanyEntityType
    includeInCompaniesView: boolean
    classificationSource: 'manual' | 'auto'
    classificationConfidence: number | null
  }>
): CompanyDetail | null {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (data.canonicalName !== undefined) {
    sets.push('canonical_name = ?')
    params.push(data.canonicalName.trim())
    sets.push('normalized_name = ?')
    params.push(normalizeCompanyName(data.canonicalName))
  }
  if (data.description !== undefined) {
    sets.push('description = ?')
    params.push(data.description)
  }
  if (data.primaryDomain !== undefined) {
    sets.push('primary_domain = ?')
    params.push(data.primaryDomain ? normalizeDomain(data.primaryDomain) : null)
  }
  if (data.websiteUrl !== undefined) {
    sets.push('website_url = ?')
    params.push(data.websiteUrl)
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

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')")
    params.push(companyId)
    db.prepare(`UPDATE org_companies SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  return getCompany(companyId)
}

function findCompanyIdByNameOrDomain(
  canonicalName: string,
  primaryDomain?: string | null
): string | null {
  const db = getDatabase()
  const normalizedName = normalizeCompanyName(canonicalName)
  const byName = db
    .prepare('SELECT id FROM org_companies WHERE normalized_name = ?')
    .get(normalizedName) as { id: string } | undefined
  if (byName?.id) return byName.id

  const normalizedDomain = primaryDomain ? normalizeDomain(primaryDomain) : null
  if (!normalizedDomain) return null

  const byDomain = db
    .prepare(`
      SELECT id
      FROM org_companies
      WHERE
        primary_domain = ?
        OR LOWER(TRIM(primary_domain)) = ?
        OR (
          CASE
            WHEN LOWER(TRIM(primary_domain)) LIKE 'www.%' THEN SUBSTR(LOWER(TRIM(primary_domain)), 5)
            ELSE LOWER(TRIM(primary_domain))
          END
        ) = ?
      LIMIT 1
    `)
    .get(normalizedDomain, normalizedDomain, normalizedDomain) as { id: string } | undefined
  return byDomain?.id || null
}

export function getOrCreateCompanyByName(canonicalName: string): CompanyDetail {
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
  })
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
}): CompanyDetail {
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
    })
  }

  const existing = getCompany(existingId)
  if (!existing) {
    throw new Error('Company not found')
  }

  const shouldSetDomain =
    data.primaryDomain
    && (!existing.primaryDomain || existing.primaryDomain === normalizeDomain(data.primaryDomain))

  const updated = updateCompany(existingId, {
    canonicalName: companyName,
    primaryDomain: shouldSetDomain ? data.primaryDomain : existing.primaryDomain,
    entityType,
    includeInCompaniesView,
    classificationSource,
    classificationConfidence
  })
  if (!updated) {
    throw new Error('Failed to update company classification')
  }
  return updated
}

export function linkMeetingCompany(
  meetingId: string,
  companyId: string,
  confidence = 1,
  linkedBy = 'manual'
): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO meeting_company_links (
      meeting_id, company_id, confidence, linked_by, created_at
    )
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(meeting_id, company_id) DO UPDATE SET
      confidence = excluded.confidence,
      linked_by = excluded.linked_by
  `).run(meetingId, companyId, confidence, linkedBy)
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
  const meetingItems: CompanyTimelineItem[] = listCompanyMeetings(companyId).map((meeting) => ({
    id: `meeting:${meeting.id}`,
    type: 'meeting',
    title: meeting.title,
    occurredAt: meeting.date,
    subtitle: meeting.status,
    referenceId: meeting.id
  }))

  const emailItems: CompanyTimelineItem[] = listCompanyEmails(companyId).map((email) => ({
    id: `email:${email.id}`,
    type: 'email',
    title: email.subject?.trim() || '(no subject)',
    occurredAt: email.receivedAt || email.sentAt || new Date().toISOString(),
    subtitle: email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail,
    referenceId: email.id
  }))

  return [...meetingItems, ...emailItems].sort((a, b) =>
    new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  )
}
