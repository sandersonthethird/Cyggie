import { getDatabase } from '../connection'
import * as settingsRepo from './settings.repo'
import type {
  DashboardActivityFilter,
  DashboardActivityItem,
  DashboardActivityType,
  DashboardCalendarCompanyContext,
  DashboardData,
  DashboardStaleCompany
} from '../../../shared/types/dashboard'
import { DEFAULT_ACTIVITY_FILTER } from '../../../shared/types/dashboard'
import type { PipelineSummaryItem, StalledPipelineCompany } from '../../../shared/types/pipeline'
import type { CompanyPipelineStage } from '../../../shared/types/company'

interface CalendarEventLookup {
  id: string
  attendeeEmails: string[]
}

function parseIntSetting(key: string, fallback: number): number {
  const raw = (settingsRepo.getSetting(key) || '').trim()
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

export function getDashboardThresholds(): {
  staleRelationshipDays: number
  stalledPipelineDays: number
} {
  return {
    staleRelationshipDays: parseIntSetting('dashboardStaleRelationshipDays', 21),
    stalledPipelineDays: parseIntSetting('dashboardStalledPipelineDays', 21)
  }
}

const STAGE_LABELS: Record<CompanyPipelineStage, string> = {
  screening: 'Screening',
  diligence: 'Diligence',
  decision: 'Decision',
  documentation: 'Documentation',
  pass: 'Pass'
}

function getPipelineStageCounts(): PipelineSummaryItem[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT pipeline_stage, COUNT(*) AS count
      FROM org_companies
      WHERE pipeline_stage IS NOT NULL
      GROUP BY pipeline_stage
    `)
    .all() as Array<{ pipeline_stage: string; count: number }>

  const countByStage = new Map(rows.map((r) => [r.pipeline_stage, r.count]))

  const stageOrder: CompanyPipelineStage[] = ['screening', 'diligence', 'decision', 'documentation', 'pass']
  return stageOrder.map((stage) => ({
    pipelineStage: stage,
    label: STAGE_LABELS[stage],
    count: countByStage.get(stage) || 0
  }))
}

function listStalledPipelineCompanies(staleDays: number, limit = 20): StalledPipelineCompany[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      WITH meeting_stats AS (
        SELECT l.company_id, MAX(m.date) AS last_meeting_at
        FROM meeting_company_links l
        JOIN meetings m ON m.id = l.meeting_id
        GROUP BY l.company_id
      ),
      email_stats AS (
        SELECT l.company_id, MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
        FROM email_company_links l
        JOIN email_messages em ON em.id = l.message_id
        GROUP BY l.company_id
      ),
      touch AS (
        SELECT
          c.id AS company_id,
          c.canonical_name AS company_name,
          c.pipeline_stage,
          COALESCE(
            CASE
              WHEN ms.last_meeting_at IS NULL THEN es.last_email_at
              WHEN es.last_email_at IS NULL THEN ms.last_meeting_at
              WHEN ms.last_meeting_at > es.last_email_at THEN ms.last_meeting_at
              ELSE es.last_email_at
            END,
            c.updated_at
          ) AS last_touchpoint
        FROM org_companies c
        LEFT JOIN meeting_stats ms ON ms.company_id = c.id
        LEFT JOIN email_stats es ON es.company_id = c.id
        WHERE c.pipeline_stage IN ('screening', 'diligence', 'decision', 'documentation')
      )
      SELECT
        company_id,
        company_name,
        pipeline_stage,
        last_touchpoint,
        CAST(julianday('now') - julianday(last_touchpoint) AS INTEGER) AS days_since_touch
      FROM touch
      WHERE julianday('now') - julianday(last_touchpoint) >= ?
      ORDER BY days_since_touch DESC, company_name ASC
      LIMIT ?
    `)
    .all(staleDays, limit) as Array<{
    company_id: string
    company_name: string
    pipeline_stage: string
    last_touchpoint: string | null
    days_since_touch: number
  }>

  return rows.map((row) => ({
    companyId: row.company_id,
    companyName: row.company_name,
    pipelineStage: row.pipeline_stage as CompanyPipelineStage,
    lastTouchpoint: row.last_touchpoint,
    daysSinceTouch: row.days_since_touch || 0
  }))
}

const ACTIVITY_SQL_MEETING = `
  SELECT
    'meeting:' || m.id AS id,
    'meeting' AS type,
    m.title AS title,
    m.status AS subtitle,
    m.date AS occurred_at,
    m.id AS reference_id,
    'meeting' AS reference_type,
    (
      SELECT l.company_id
      FROM meeting_company_links l
      WHERE l.meeting_id = m.id
      ORDER BY l.confidence DESC, datetime(l.created_at) ASC
      LIMIT 1
    ) AS company_id
  FROM meetings m
`

const ACTIVITY_SQL_EMAIL_ALL = `
  SELECT
    'email:' || em.id AS id,
    'email' AS type,
    COALESCE(NULLIF(TRIM(em.subject), ''), '(no subject)') AS title,
    em.from_email AS subtitle,
    COALESCE(em.received_at, em.sent_at, em.created_at) AS occurred_at,
    em.id AS reference_id,
    'email' AS reference_type,
    (
      SELECT l.company_id
      FROM email_company_links l
      WHERE l.message_id = em.id
      ORDER BY l.confidence DESC, datetime(l.created_at) ASC
      LIMIT 1
    ) AS company_id
  FROM email_messages em
`

const ACTIVITY_SQL_EMAIL_PIPELINE_PORTFOLIO = `
  SELECT
    'email:' || em.id AS id,
    'email' AS type,
    COALESCE(NULLIF(TRIM(em.subject), ''), '(no subject)') AS title,
    em.from_email AS subtitle,
    COALESCE(em.received_at, em.sent_at, em.created_at) AS occurred_at,
    em.id AS reference_id,
    'email' AS reference_type,
    (
      SELECT l.company_id
      FROM email_company_links l
      WHERE l.message_id = em.id
      ORDER BY l.confidence DESC, datetime(l.created_at) ASC
      LIMIT 1
    ) AS company_id
  FROM email_messages em
  WHERE EXISTS (
    SELECT 1
    FROM email_company_links ecl
    JOIN org_companies oc ON oc.id = ecl.company_id
    WHERE ecl.message_id = em.id
      AND (
        oc.entity_type = 'portfolio'
        OR oc.pipeline_stage IS NOT NULL
      )
  )
`

const ACTIVITY_SQL_NOTE = `
  SELECT
    'note:' || n.id AS id,
    'note' AS type,
    COALESCE(NULLIF(TRIM(n.title), ''), 'Note') AS title,
    substr(replace(replace(trim(n.content), char(10), ' '), char(13), ' '), 1, 200) AS subtitle,
    n.updated_at AS occurred_at,
    n.id AS reference_id,
    'company_note' AS reference_type,
    n.company_id AS company_id
  FROM company_notes n
`

function getActivityFilter(): DashboardActivityFilter {
  const raw = settingsRepo.getSetting('dashboardActivityFilter')
  if (!raw) return DEFAULT_ACTIVITY_FILTER
  try {
    const parsed = JSON.parse(raw) as Partial<DashboardActivityFilter>
    const validTypes: DashboardActivityType[] = ['meeting', 'email', 'note']
    const types = Array.isArray(parsed.types)
      ? parsed.types.filter((t) => validTypes.includes(t as DashboardActivityType))
      : DEFAULT_ACTIVITY_FILTER.types
    const emailCompanyFilter =
      parsed.emailCompanyFilter === 'all' || parsed.emailCompanyFilter === 'pipeline_portfolio'
        ? parsed.emailCompanyFilter
        : DEFAULT_ACTIVITY_FILTER.emailCompanyFilter
    return { types: types as DashboardActivityType[], emailCompanyFilter }
  } catch {
    return DEFAULT_ACTIVITY_FILTER
  }
}

function listRecentActivity(limit = 20): DashboardActivityItem[] {
  const db = getDatabase()
  const filter = getActivityFilter()
  const unions: string[] = []

  if (filter.types.includes('meeting')) unions.push(ACTIVITY_SQL_MEETING)
  if (filter.types.includes('email')) {
    unions.push(
      filter.emailCompanyFilter === 'pipeline_portfolio'
        ? ACTIVITY_SQL_EMAIL_PIPELINE_PORTFOLIO
        : ACTIVITY_SQL_EMAIL_ALL
    )
  }
  if (filter.types.includes('note')) unions.push(ACTIVITY_SQL_NOTE)

  if (unions.length === 0) return []

  const sql = `
    SELECT
      activity.id,
      activity.type,
      activity.title,
      activity.subtitle,
      activity.occurred_at,
      activity.reference_id,
      activity.reference_type,
      activity.company_id,
      c.canonical_name AS company_name
    FROM (${unions.join(' UNION ALL ')}) activity
    LEFT JOIN org_companies c ON c.id = activity.company_id
    ORDER BY datetime(activity.occurred_at) DESC
    LIMIT ?
  `

  const rows = db.prepare(sql).all(limit) as Array<{
    id: string
    type: DashboardActivityItem['type']
    title: string
    subtitle: string | null
    occurred_at: string
    reference_id: string
    reference_type: DashboardActivityItem['referenceType']
    company_id: string | null
    company_name: string | null
  }>

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    occurredAt: row.occurred_at,
    referenceId: row.reference_id,
    referenceType: row.reference_type,
    companyId: row.company_id,
    companyName: row.company_name
  }))
}

function listStaleCompanies(staleDays: number, limit = 20): DashboardStaleCompany[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      WITH meeting_stats AS (
        SELECT l.company_id, COUNT(DISTINCT l.meeting_id) AS meeting_count, MAX(m.date) AS last_meeting_at
        FROM meeting_company_links l
        JOIN meetings m ON m.id = l.meeting_id
        GROUP BY l.company_id
      ),
      email_stats AS (
        SELECT l.company_id, COUNT(DISTINCT l.message_id) AS email_count,
               MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
        FROM email_company_links l
        JOIN email_messages em ON em.id = l.message_id
        GROUP BY l.company_id
      ),
      touch AS (
        SELECT
          c.id AS company_id,
          c.canonical_name AS company_name,
          COALESCE(ms.meeting_count, 0) AS meeting_count,
          COALESCE(es.email_count, 0) AS email_count,
          COALESCE(
            CASE
              WHEN ms.last_meeting_at IS NULL THEN es.last_email_at
              WHEN es.last_email_at IS NULL THEN ms.last_meeting_at
              WHEN ms.last_meeting_at > es.last_email_at THEN ms.last_meeting_at
              ELSE es.last_email_at
            END,
            c.updated_at
          ) AS last_touchpoint
        FROM org_companies c
        LEFT JOIN meeting_stats ms ON ms.company_id = c.id
        LEFT JOIN email_stats es ON es.company_id = c.id
      )
      SELECT
        company_id,
        company_name,
        meeting_count,
        email_count,
        last_touchpoint,
        CAST(julianday('now') - julianday(last_touchpoint) AS INTEGER) AS days_since_touch
      FROM touch
      WHERE julianday('now') - julianday(last_touchpoint) >= ?
      ORDER BY days_since_touch DESC, company_name ASC
      LIMIT ?
    `)
    .all(staleDays, limit) as Array<{
    company_id: string
    company_name: string
    meeting_count: number
    email_count: number
    last_touchpoint: string | null
    days_since_touch: number
  }>

  return rows.map((row) => ({
    companyId: row.company_id,
    companyName: row.company_name,
    meetingCount: row.meeting_count || 0,
    emailCount: row.email_count || 0,
    lastTouchpoint: row.last_touchpoint,
    daysSinceTouch: row.days_since_touch || 0
  }))
}

export function getDashboardData(): DashboardData {
  const { staleRelationshipDays, stalledPipelineDays } = getDashboardThresholds()
  return {
    pipelineSummary: getPipelineStageCounts(),
    recentActivity: listRecentActivity(20),
    needsAttention: {
      staleCompanies: listStaleCompanies(staleRelationshipDays, 20),
      stalledCompanies: listStalledPipelineCompanies(stalledPipelineDays)
    },
    staleRelationshipDays,
    stalledPipelineDays,
    activityFilter: getActivityFilter()
  }
}

export function enrichCalendarEventsWithCompanyContext(
  events: CalendarEventLookup[]
): DashboardCalendarCompanyContext[] {
  const normalizedEvents = events.map((event) => ({
    id: event.id,
    attendeeEmails: event.attendeeEmails
      .map((email) => email.trim().toLowerCase())
      .filter((email) => Boolean(email))
  }))

  const emailSet = new Set<string>()
  normalizedEvents.forEach((event) => {
    event.attendeeEmails.forEach((email) => emailSet.add(email))
  })
  if (emailSet.size === 0) return []

  const db = getDatabase()
  const emails = [...emailSet]
  const placeholders = emails.map(() => '?').join(', ')

  const emailMappings = db
    .prepare(`
      SELECT LOWER(email) AS email, primary_company_id AS company_id
      FROM contacts
      WHERE primary_company_id IS NOT NULL AND LOWER(email) IN (${placeholders})
      UNION ALL
      SELECT LOWER(ce.email) AS email, c.primary_company_id AS company_id
      FROM contact_emails ce
      JOIN contacts c ON c.id = ce.contact_id
      WHERE c.primary_company_id IS NOT NULL AND LOWER(ce.email) IN (${placeholders})
    `)
    .all(...emails, ...emails) as Array<{
    email: string
    company_id: string | null
  }>

  const companyByEmail = new Map<string, string[]>()
  emailMappings.forEach((mapping) => {
    if (!mapping.company_id) return
    const existing = companyByEmail.get(mapping.email)
    if (existing) {
      existing.push(mapping.company_id)
    } else {
      companyByEmail.set(mapping.email, [mapping.company_id])
    }
  })

  const matchedCompanyIds = new Set<string>()
  const eventToCompany = new Map<string, string>()
  normalizedEvents.forEach((event) => {
    const companyCounts = new Map<string, number>()
    event.attendeeEmails.forEach((email) => {
      const companyIds = companyByEmail.get(email) || []
      companyIds.forEach((companyId) => {
        companyCounts.set(companyId, (companyCounts.get(companyId) || 0) + 1)
      })
    })
    const winner = [...companyCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (winner) {
      eventToCompany.set(event.id, winner)
      matchedCompanyIds.add(winner)
    }
  })

  if (matchedCompanyIds.size === 0) return []
  const matched = [...matchedCompanyIds]
  const companyPlaceholders = matched.map(() => '?').join(', ')

  const companyRows = db
    .prepare(`
      WITH meeting_stats AS (
        SELECT l.company_id, COUNT(DISTINCT l.meeting_id) AS meeting_count, MAX(m.date) AS last_meeting_at
        FROM meeting_company_links l
        JOIN meetings m ON m.id = l.meeting_id
        GROUP BY l.company_id
      ),
      email_stats AS (
        SELECT l.company_id, COUNT(DISTINCT l.message_id) AS email_count,
               MAX(COALESCE(em.received_at, em.sent_at, em.created_at)) AS last_email_at
        FROM email_company_links l
        JOIN email_messages em ON em.id = l.message_id
        GROUP BY l.company_id
      )
      SELECT
        c.id,
        c.canonical_name,
        c.entity_type,
        c.pipeline_stage,
        COALESCE(ms.meeting_count, 0) AS meeting_count,
        COALESCE(es.email_count, 0) AS email_count,
        COALESCE(
          CASE
            WHEN ms.last_meeting_at IS NULL THEN es.last_email_at
            WHEN es.last_email_at IS NULL THEN ms.last_meeting_at
            WHEN ms.last_meeting_at > es.last_email_at THEN ms.last_meeting_at
            ELSE es.last_email_at
          END,
          c.updated_at
        ) AS last_touchpoint
      FROM org_companies c
      LEFT JOIN meeting_stats ms ON ms.company_id = c.id
      LEFT JOIN email_stats es ON es.company_id = c.id
      WHERE c.id IN (${companyPlaceholders})
    `)
    .all(...matched) as Array<{
    id: string
    canonical_name: string
    entity_type: string
    pipeline_stage: string | null
    meeting_count: number
    email_count: number
    last_touchpoint: string | null
  }>
  const companyMap = new Map(companyRows.map((row) => [row.id, row]))

  const contexts: DashboardCalendarCompanyContext[] = []
  eventToCompany.forEach((companyId, eventId) => {
    const company = companyMap.get(companyId)
    if (!company) return
    contexts.push({
      eventId,
      companyId: company.id,
      companyName: company.canonical_name,
      entityType: company.entity_type,
      lastTouchpoint: company.last_touchpoint,
      meetingCount: company.meeting_count || 0,
      emailCount: company.email_count || 0,
      pipelineStage: company.pipeline_stage
    })
  })

  return contexts
}
