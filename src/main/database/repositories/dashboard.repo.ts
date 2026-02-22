import { getDatabase } from '../connection'
import * as settingsRepo from './settings.repo'
import * as dealRepo from './deal.repo'
import type {
  DashboardActivityItem,
  DashboardCalendarCompanyContext,
  DashboardData,
  DashboardStaleCompany
} from '../../../shared/types/dashboard'

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
  stuckDealDays: number
} {
  return {
    staleRelationshipDays: parseIntSetting('dashboardStaleRelationshipDays', 21),
    stuckDealDays: parseIntSetting('dashboardStuckDealDays', 21)
  }
}

function listRecentActivity(limit = 20): DashboardActivityItem[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
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
      FROM (
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

        UNION ALL

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

        UNION ALL

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

        UNION ALL

        SELECT
          'deal-event:' || dse.id AS id,
          'deal_event' AS type,
          CASE
            WHEN dse.from_stage IS NULL OR TRIM(dse.from_stage) = ''
              THEN 'Moved to ' || dse.to_stage
            ELSE dse.from_stage || ' -> ' || dse.to_stage
          END AS title,
          dse.note AS subtitle,
          dse.event_time AS occurred_at,
          dse.id AS reference_id,
          'deal_stage_event' AS reference_type,
          d.company_id AS company_id
        FROM deal_stage_events dse
        JOIN deals d ON d.id = dse.deal_id
      ) activity
      LEFT JOIN org_companies c ON c.id = activity.company_id
      ORDER BY datetime(activity.occurred_at) DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
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
  const { staleRelationshipDays, stuckDealDays } = getDashboardThresholds()
  return {
    pipelineSummary: dealRepo.getPipelineSummary(),
    recentActivity: listRecentActivity(20),
    needsAttention: {
      staleCompanies: listStaleCompanies(staleRelationshipDays, 20),
      stuckDeals: dealRepo.listStuckDeals(stuckDealDays)
    },
    staleRelationshipDays,
    stuckDealDays
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
        ) AS last_touchpoint,
        (
          SELECT COALESCE(ps.label, d.stage)
          FROM deals d
          LEFT JOIN pipeline_stages ps ON ps.id = d.stage_id
          WHERE d.company_id = c.id
          ORDER BY datetime(d.updated_at) DESC
          LIMIT 1
        ) AS active_deal_stage
      FROM org_companies c
      LEFT JOIN meeting_stats ms ON ms.company_id = c.id
      LEFT JOIN email_stats es ON es.company_id = c.id
      WHERE c.id IN (${companyPlaceholders})
    `)
    .all(...matched) as Array<{
    id: string
    canonical_name: string
    entity_type: string
    meeting_count: number
    email_count: number
    last_touchpoint: string | null
    active_deal_stage: string | null
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
      activeDealStage: company.active_deal_stage
    })
  })

  return contexts
}
