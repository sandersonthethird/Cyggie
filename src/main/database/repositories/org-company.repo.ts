import { randomUUID } from 'crypto'
import { getDatabase } from '../connection'
import { jaroWinkler } from '../../utils/jaroWinkler'
import { UnionFind } from '../../utils/unionFind'
import { splitCamelCase } from '../../utils/string-utils'
import { trySegment } from '../../utils/company-extractor'
import { extractDomainFromWebsiteUrl, normalizeDomain } from '../../utils/email-parser'
import { logAudit } from './audit.repo'
import type {
  CompanyEntityType,
  CompanyPriority,
  CompanyRound,
  CompanyStatus,
  CompanyPipelineStage,
  CompanySortBy,
  CompanyListFilter,
  CompanySummary,
  CompanyDetail,
  CompanyMeetingRef,
  CompanyContactRef,
  CompanyEmailRef,
  CompanyFileRef,
  CompanyTimelineItem,
  CompanyDedupAction,
  CompanyDedupApplyResult,
  CompanyDedupDecision,
  CompanyDuplicateGroup,
  CompanyDuplicateSummary,
  CompanyMergePreview,
  MergeFieldDiff,
  MergeFieldOverrides
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
  contact_count: number
  priority: string | null
  post_money_valuation: number | null
  raise_size: number | null
  round: string | null
  pipeline_stage: string | null
  last_touchpoint: string | null
  created_at: string
  updated_at: string
  // New fields from migration 037
  founding_year: number | null
  employee_count_range: string | null
  hq_address: string | null
  linkedin_company_url: string | null
  twitter_handle: string | null
  crunchbase_url: string | null
  angellist_url: string | null
  industry: string | null
  target_customer: string | null
  business_model: string | null
  product_stage: string | null
  revenue_model: string | null
  arr: number | null
  burn_rate: number | null
  runway_months: number | null
  last_funding_date: string | null
  total_funding_raised: number | null
  lead_investor: string | null
  co_investors: string | null  // legacy column kept in DB, not surfaced in TypeScript types
  source_type: string | null
  source_entity_type: string | null
  source_entity_id: string | null
  relationship_owner: string | null
  deal_source: string | null
  warm_intro_source: string | null
  referral_contact_id: string | null
  next_followup_date: string | null
  field_sources: string | null
  key_takeaways: string | null
  // Portfolio fields from migration 045
  portfolio_fund: string | null
  investment_size: string | null
  ownership_pct: string | null
  followon_investment_size: string | null
  total_invested: string | null
  // Portfolio investment fields from migration 073
  investment_mark: number | null
  investment_round: string | null
  initial_investment_security: string | null
  date_of_initial_investment: string | null
  initial_round_size: number | null
  last_company_valuation: number | null
  followon_check: number | null
  followon_date: string | null
  followon_check_2: number | null
  followon_date_2: string | null
  // Denormalized list-view fields (conditional GROUP_CONCAT joins)
  co_investor_names: string | null
  co_investors_json: string | null
  prior_investor_names: string | null
  prior_investors_json: string | null
  subsequent_investor_names: string | null
  subsequent_investors_json: string | null
  // Lead investor link (joined from org_companies)
  lead_investor_company_id: string | null
  lead_investor_company_name: string | null
  lead_investor_company_domain: string | null
}

/**
 * Parse a json_group_array result from SQLite into a typed list of investors.
 * Tolerates: null (no JOIN match), '[]' (empty), or malformed JSON (logs + empty).
 *
 *   '[{"id":"abc","name":"Sequoia","domain":"sequoia.com"}]'  →  parsed entry
 *   null                                                       →  []
 *   '[]'                                                       →  []
 *   garbage                                                    →  []  (with console.error)
 */
export function parseInvestorsJson(raw: string | null | undefined): Array<{ id: string; name: string; domain: string | null }> {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: Array<{ id: string; name: string; domain: string | null }> = []
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string' && typeof entry.name === 'string') {
        out.push({
          id: entry.id,
          name: entry.name,
          domain: typeof entry.domain === 'string' ? entry.domain : null,
        })
      }
    }
    return out
  } catch (err) {
    console.error('[org-company.repo] parseInvestorsJson failed:', err, 'raw:', raw.slice(0, 200))
    return []
  }
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

const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN
  const trimmed = value.trim()
  if (!trimmed) return Number.NaN
  const normalized = SQLITE_DATETIME_RE.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed
  return Date.parse(normalized)
}

const MAX_FUZZY_CANDIDATES = 5000
const FUZZY_THRESHOLD = 0.88

/**
 * Order two duplicates so the "best to keep" is sorted first (index 0).
 * Priority: richest record (more fields + more activity) > most-recently-updated > name > id.
 * Richness wins over recency because a freshly-created stub often has a newer updated_at
 * than the curated record that should actually be kept.
 */
function compareDuplicateCompanies(a: CompanyDuplicateSummary, b: CompanyDuplicateSummary): number {
  const richnessScore = (c: CompanyDuplicateSummary) =>
    c.populatedFieldCount + c.meetingCount + c.emailCount + c.noteCount
  const aRich = richnessScore(a)
  const bRich = richnessScore(b)
  if (aRich !== bRich) return bRich - aRich

  const aUpdated = parseTimestamp(a.updatedAt)
  const bUpdated = parseTimestamp(b.updatedAt)
  if (!Number.isNaN(aUpdated) && !Number.isNaN(bUpdated) && aUpdated !== bUpdated) {
    return bUpdated - aUpdated
  }
  const aName = (a.canonicalName || '').trim().toLowerCase()
  const bName = (b.canonicalName || '').trim().toLowerCase()
  if (aName !== bName) return aName.localeCompare(bName)
  return a.id.localeCompare(b.id)
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
    'lp',
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

function normalizeStatus(value: string | null | undefined): CompanyStatus {
  const normalized = (value || '').trim().toLowerCase()
  return normalized === 'exited' || normalized === 'shut_down'
    ? normalized
    : 'active'
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

interface EmailMessageRow {
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
  thread_group: string
  provider_thread_id?: string | null
  thread_message_count: number
  participants_json: string
  account_email?: string | null
}

function mapEmailRow(row: EmailMessageRow): CompanyEmailRef {
  return {
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
    providerThreadId: row.provider_thread_id ?? null,
    threadMessageCount: row.thread_message_count || 1,
    threadGroup: row.thread_group,
    participants: parseEmailParticipants(row.participants_json),
    accountEmail: row.account_email ?? null,
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
    status: normalizeStatus(row.status),
    crmProvider: row.crm_provider,
    crmCompanyId: row.crm_company_id,
    entityType: normalizeEntityType(row.entity_type),
    includeInCompaniesView: row.include_in_companies_view === 1,
    classificationSource: row.classification_source === 'manual' ? 'manual' : 'auto',
    classificationConfidence: row.classification_confidence,
    meetingCount: row.meeting_count || 0,
    emailCount: row.email_count || 0,
    noteCount: row.note_count || 0,
    contactCount: row.contact_count || 0,
    priority: (row.priority as CompanyPriority) || null,
    postMoneyValuation: row.post_money_valuation,
    raiseSize: row.raise_size,
    round: (row.round as CompanyRound) || null,
    pipelineStage: (row.pipeline_stage as CompanyPipelineStage) || null,
    lastTouchpoint: row.last_touchpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // New fields
    foundingYear: row.founding_year ?? null,
    employeeCountRange: row.employee_count_range ?? null,
    hqAddress: row.hq_address ?? null,
    linkedinCompanyUrl: row.linkedin_company_url ?? null,
    twitterHandle: row.twitter_handle ?? null,
    crunchbaseUrl: row.crunchbase_url ?? null,
    angellistUrl: row.angellist_url ?? null,
    industry: row.industry ?? null,
    targetCustomer: row.target_customer ?? null,
    businessModel: row.business_model ?? null,
    productStage: row.product_stage ?? null,
    revenueModel: row.revenue_model ?? null,
    arr: row.arr ?? null,
    burnRate: row.burn_rate ?? null,
    runwayMonths: row.runway_months ?? null,
    lastFundingDate: row.last_funding_date ?? null,
    totalFundingRaised: row.total_funding_raised ?? null,
    leadInvestor: row.lead_investor ?? null,
    sourceType: row.source_type ?? null,
    sourceEntityType: (row.source_entity_type as 'company' | 'contact' | null) ?? null,
    sourceEntityId: row.source_entity_id ?? null,
    relationshipOwner: row.relationship_owner ?? null,
    dealSource: row.deal_source ?? null,
    warmIntroSource: row.warm_intro_source ?? null,
    referralContactId: row.referral_contact_id ?? null,
    nextFollowupDate: row.next_followup_date ?? null,
    fieldSources: row.field_sources ?? null,
    keyTakeaways: row.key_takeaways ?? null,
    portfolioFund: (row.portfolio_fund as CompanySummary['portfolioFund']) || null,
    investmentSize: row.investment_size ?? null,
    ownershipPct: row.ownership_pct ?? null,
    followonInvestmentSize: row.followon_investment_size ?? null,
    totalInvested: row.total_invested ?? null,
    // Portfolio investment fields (migration 073)
    investmentMark: row.investment_mark ?? null,
    investmentRound: (row.investment_round as CompanySummary['investmentRound']) || null,
    initialInvestmentSecurity: row.initial_investment_security ?? null,
    dateOfInitialInvestment: row.date_of_initial_investment ?? null,
    initialRoundSize: row.initial_round_size ?? null,
    lastCompanyValuation: row.last_company_valuation ?? null,
    followonCheck: row.followon_check ?? null,
    followonDate: row.followon_date ?? null,
    followonCheck2: row.followon_check_2 ?? null,
    followonDate2: row.followon_date_2 ?? null,
    // Denormalized list-view fields
    coInvestorNames: row.co_investor_names ?? null,
    coInvestorsList: parseInvestorsJson(row.co_investors_json),
    priorInvestorNames: row.prior_investor_names ?? null,
    priorInvestorsList: parseInvestorsJson(row.prior_investors_json),
    subsequentInvestorNames: row.subsequent_investor_names ?? null,
    subsequentInvestorsList: parseInvestorsJson(row.subsequent_investors_json),
    leadInvestorCompany: row.lead_investor_company_id && row.lead_investor_company_name
      ? {
          id: row.lead_investor_company_id,
          name: row.lead_investor_company_name,
          domain: row.lead_investor_company_domain ?? null,
        }
      : null,
  }
}

interface BaseSelectOpts {
  includeInvestorNames?: boolean
}

function baseCompanySelect(whereClause = '', opts?: BaseSelectOpts): string {
  const investorCols = opts?.includeInvestorNames
    ? `coinv.co_investor_names, coinv.co_investors_json,
       priorinv.prior_investor_names, priorinv.prior_investors_json,
       subinv.subsequent_investor_names, subinv.subsequent_investors_json`
    : `NULL AS co_investor_names, NULL AS co_investors_json,
       NULL AS prior_investor_names, NULL AS prior_investors_json,
       NULL AS subsequent_investor_names, NULL AS subsequent_investors_json`

  // Rollup queries are ORDERed inside subqueries via inner SELECT to ensure
  // GROUP_CONCAT and json_group_array preserve user-specified position order.
  const coinvestorJoin = opts?.includeInvestorNames ? `
    LEFT JOIN (
      SELECT
        company_id,
        GROUP_CONCAT(name, ', ') AS co_investor_names,
        json_group_array(json_object('id', id, 'name', name, 'domain', domain)) AS co_investors_json
      FROM (
        SELECT ci.company_id, oc.id AS id, oc.canonical_name AS name, oc.primary_domain AS domain
        FROM company_investors ci
        JOIN org_companies oc ON oc.id = ci.investor_company_id
        WHERE ci.investor_type = 'co_investor'
        ORDER BY ci.position, ci.created_at
      )
      GROUP BY company_id
    ) coinv ON coinv.company_id = c.id
    LEFT JOIN (
      SELECT
        company_id,
        GROUP_CONCAT(name, ', ') AS prior_investor_names,
        json_group_array(json_object('id', id, 'name', name, 'domain', domain)) AS prior_investors_json
      FROM (
        SELECT ci.company_id, oc.id AS id, oc.canonical_name AS name, oc.primary_domain AS domain
        FROM company_investors ci
        JOIN org_companies oc ON oc.id = ci.investor_company_id
        WHERE ci.investor_type = 'prior_investor'
        ORDER BY ci.position, ci.created_at
      )
      GROUP BY company_id
    ) priorinv ON priorinv.company_id = c.id
    LEFT JOIN (
      SELECT
        company_id,
        GROUP_CONCAT(name, ', ') AS subsequent_investor_names,
        json_group_array(json_object('id', id, 'name', name, 'domain', domain)) AS subsequent_investors_json
      FROM (
        SELECT ci.company_id, oc.id AS id, oc.canonical_name AS name, oc.primary_domain AS domain
        FROM company_investors ci
        JOIN org_companies oc ON oc.id = ci.investor_company_id
        WHERE ci.investor_type = 'subsequent_investor'
        ORDER BY ci.position, ci.created_at
      )
      GROUP BY company_id
    ) subinv ON subinv.company_id = c.id` : ''

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
      COALESCE(cc.contact_count, 0) AS contact_count,
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
      c.updated_at,
      c.founding_year,
      c.employee_count_range,
      c.hq_address,
      c.linkedin_company_url,
      c.twitter_handle,
      c.crunchbase_url,
      c.angellist_url,
      c.industry,
      c.target_customer,
      c.business_model,
      c.product_stage,
      c.revenue_model,
      c.arr,
      c.burn_rate,
      c.runway_months,
      c.last_funding_date,
      c.total_funding_raised,
      c.lead_investor,
      c.lead_investor_company_id,
      lead_inv.canonical_name AS lead_investor_company_name,
      lead_inv.primary_domain AS lead_investor_company_domain,
      c.co_investors,
      c.source_type,
      c.source_entity_type,
      c.source_entity_id,
      c.relationship_owner,
      c.deal_source,
      c.warm_intro_source,
      c.referral_contact_id,
      c.next_followup_date,
      NULL AS field_sources,
      c.portfolio_fund,
      c.investment_size,
      c.ownership_pct,
      c.followon_investment_size,
      c.total_invested,
      c.investment_mark,
      c.investment_round,
      c.initial_investment_security,
      c.date_of_initial_investment,
      c.initial_round_size,
      c.last_company_valuation,
      c.followon_check,
      c.followon_date,
      c.followon_check_2,
      c.followon_date_2,
      ${investorCols}
    FROM org_companies c
    LEFT JOIN org_companies lead_inv ON lead_inv.id = c.lead_investor_company_id
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
        company_id,
        COUNT(DISTINCT message_id) AS email_count,
        MAX(sort_at) AS last_email_at
      FROM (
        SELECT l.company_id, l.message_id, COALESCE(em.received_at, em.sent_at, em.created_at) AS sort_at
        FROM email_company_links l
        JOIN email_messages em ON em.id = l.message_id
        UNION
        SELECT
          COALESCE(c.primary_company_id, occ.company_id) AS company_id,
          p.message_id,
          COALESCE(em.received_at, em.sent_at, em.created_at) AS sort_at
        FROM email_message_participants p
        JOIN email_messages em ON em.id = p.message_id
        JOIN contacts c ON c.id = p.contact_id
        LEFT JOIN org_company_contacts occ ON occ.contact_id = c.id
        WHERE COALESCE(c.primary_company_id, occ.company_id) IS NOT NULL
      )
      GROUP BY company_id
    ) ec ON ec.company_id = c.id
    LEFT JOIN (
      SELECT company_id, COUNT(*) AS note_count
      FROM notes
      WHERE company_id IS NOT NULL
      GROUP BY company_id
    ) nc ON nc.company_id = c.id
    LEFT JOIN (
      SELECT primary_company_id, COUNT(*) AS contact_count
      FROM contacts
      WHERE primary_company_id IS NOT NULL
      GROUP BY primary_company_id
    ) cc ON cc.primary_company_id = c.id${coinvestorJoin}
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
      c.updated_at,
      c.portfolio_fund,
      NULL AS field_sources,
      NULL AS key_takeaways,
      c.investment_size,
      c.ownership_pct,
      c.followon_investment_size,
      c.total_invested,
      c.investment_mark,
      c.investment_round,
      c.initial_investment_security,
      c.date_of_initial_investment,
      c.initial_round_size,
      c.last_company_valuation,
      c.followon_check,
      c.followon_date,
      c.followon_check_2,
      c.followon_date_2,
      NULL AS co_investor_names,
      NULL AS co_investors_json,
      NULL AS prior_investor_names,
      NULL AS prior_investors_json,
      NULL AS subsequent_investor_names,
      NULL AS subsequent_investors_json,
      c.lead_investor_company_id,
      lead_inv.canonical_name AS lead_investor_company_name,
      lead_inv.primary_domain AS lead_investor_company_domain
    FROM org_companies c
    LEFT JOIN org_companies lead_inv ON lead_inv.id = c.lead_investor_company_id
    ${whereClause}
  `
}

function buildCompanyOrderBy(sortBy: CompanySortBy | undefined, includeLastTouchpoint: boolean): string {
  if (sortBy === 'name') {
    return `
      ORDER BY
        lower(c.canonical_name) ASC,
        lower(COALESCE(c.primary_domain, '')) ASC
    `
  }

  if (includeLastTouchpoint) {
    return `
      ORDER BY datetime(last_touchpoint) DESC, c.canonical_name ASC
    `
  }

  return `
    ORDER BY datetime(c.updated_at) DESC, c.canonical_name ASC
  `
}

export function listCompanies(filter?: CompanyListFilter): CompanySummary[] {
  const db = getDatabase()
  const query = filter?.query?.trim()
  const view = filter?.view ?? 'companies'
  const conditions: string[] = []
  const params: unknown[] = []

  if (view === 'companies') {
    conditions.push('c.include_in_companies_view = 1')
  } else if (view === 'hidden') {
    conditions.push('c.include_in_companies_view = 0')
  } else if (view === 'stubs') {
    // Phase 3: investor-stub pollution detection.
    // A "stub" is a sparse company that's referenced by some other company's
    // investor list (so it was likely created via find-or-create) AND has
    // no enrichment, no domain, no activity.
    conditions.push(`(
      c.entity_type = 'unknown'
      AND (c.primary_domain IS NULL OR c.primary_domain = '')
      AND (c.description IS NULL OR c.description = '')
      AND (c.lead_investor IS NULL OR c.lead_investor = '')
      AND EXISTS (SELECT 1 FROM company_investors WHERE investor_company_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM meeting_company_links WHERE company_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM email_company_links WHERE company_id = c.id)
    )`)
  }

  if (query) {
    const words = query.split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      // Multi-word: each word must appear in canonical_name (AND logic).
      // "Bowery Capital" → LIKE '%Bowery%' AND LIKE '%Capital%'.
      // Domain/description still match on the full original string.
      const nameClauses = words.map(() => 'c.canonical_name LIKE ?').join(' AND ')
      conditions.push(`((${nameClauses}) OR c.primary_domain LIKE ? OR c.description LIKE ?)`)
      words.forEach(w => params.push(`%${w}%`))
      params.push(`%${query}%`, `%${query}%`)
    } else {
      conditions.push('(c.canonical_name LIKE ? OR c.primary_domain LIKE ? OR c.description LIKE ?)')
      params.push(`%${query}%`, `%${query}%`, `%${query}%`)
    }
  }

  if (filter?.entityTypes && filter.entityTypes.length > 0) {
    const normalizedEntityTypes = [...new Set(filter.entityTypes.map(normalizeEntityType))]
    const placeholders = normalizedEntityTypes.map(() => '?').join(', ')
    conditions.push(`c.entity_type IN (${placeholders})`)
    params.push(...normalizedEntityTypes)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = filter?.limit        // undefined = no limit (returns all matching rows)
  const offset = filter?.offset ?? 0
  const paginate = limit !== undefined
  const includeStats = filter?.includeStats === true
  const selectOpts: BaseSelectOpts = {
    includeInvestorNames: filter?.includeInvestorNames,
  }

  const rows = db
    .prepare(
      `${includeStats ? baseCompanySelect(where, selectOpts) : baseCompanySelectLight(where)}
       ${buildCompanyOrderBy(filter?.sortBy, includeStats)}
       ${paginate ? 'LIMIT ? OFFSET ?' : ''}`
    )
    .all(...(paginate ? [...params, limit, offset] : params)) as CompanyRow[]

  return rows.map(rowToCompanySummary)
}

/**
 * Count investor-stub-pollution candidates. Used by the Dashboard banner.
 *
 * Mirrors the `view: 'stubs'` filter in listCompanies — a stub is a sparse
 * org_companies row referenced by another company's investor list with no
 * enrichment and no activity. See listCompanies WHERE clause for the exact
 * predicate.
 */
export function countStubCompanies(): number {
  const db = getDatabase()
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM org_companies c
      WHERE c.entity_type = 'unknown'
        AND (c.primary_domain IS NULL OR c.primary_domain = '')
        AND (c.description IS NULL OR c.description = '')
        AND (c.lead_investor IS NULL OR c.lead_investor = '')
        AND EXISTS (SELECT 1 FROM company_investors WHERE investor_company_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM meeting_company_links WHERE company_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM email_company_links WHERE company_id = c.id)
    `).get() as { n: number } | undefined
    return row?.n ?? 0
  } catch (err) {
    console.error('[org-company.repo] countStubCompanies failed:', err)
    return 0
  }
}

export function listPipelineCompanies(filter?: {
  pipelineStage?: CompanyPipelineStage | null
  priority?: CompanyPriority | null
  round?: CompanyRound | null
  query?: string
  passExpiryBefore?: string | null
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
  if (filter?.passExpiryBefore) {
    // Exclude pass-stage companies moved to pass more than N days ago.
    // Stage changes are auto-logged as 'Stage Change'; the most recent one for a pass-stage
    // company is when it entered pass. Companies with no stage-change log are kept (NULL < x
    // is false in SQLite).
    conditions.push(`NOT (
      c.pipeline_stage = 'pass'
      AND (
        SELECT MAX(cdl.decision_date)
        FROM company_decision_logs cdl
        WHERE cdl.company_id = c.id AND cdl.decision_type = 'Stage Change'
      ) < ?
    )`)
    params.push(filter.passExpiryBefore)
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
           WHEN 'medium' THEN 1
           WHEN 'monitor' THEN 2
           WHEN 'low' THEN 3
           ELSE 4
         END,
         c.canonical_name ASC
       LIMIT 500`
    )
    .all(...params) as CompanyRow[]

  return rows.map(rowToCompanySummary)
}

/**
 * Read-only batch fetch by normalized name.
 * Safe to call during previewImport — has NO CREATE side effects.
 * (Never use getOrCreateCompanyByName in preview — it creates companies.)
 * Chunked at 500 to stay under SQLite's 999-variable limit.
 */
export function getCompaniesByNormalizedNames(names: string[]): Record<string, CompanyDetail> {
  if (names.length === 0) return {}
  const db = getDatabase()
  const CHUNK = 500
  const result: Record<string, CompanyDetail> = {}
  for (let i = 0; i < names.length; i += CHUNK) {
    const chunk = names.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db
      .prepare(
        `SELECT id, canonical_name, normalized_name, entity_type, pipeline_stage,
                primary_domain, industry, city, state, arr, raise_size, round
         FROM org_companies WHERE lower(normalized_name) IN (${placeholders})`
      )
      .all(...chunk.map((n) => n.toLowerCase())) as Array<{
        id: string
        canonical_name: string
        normalized_name: string
        entity_type: string | null
        pipeline_stage: string | null
        primary_domain: string | null
        industry: string | null
        city: string | null
        state: string | null
        arr: number | null
        raise_size: number | null
        round: string | null
      }>
    for (const r of rows) {
      // Build a minimal CompanyDetail (only comparison fields are populated from DB;
      // other required fields use null/empty defaults — not used for display)
      const nullStr = null as string | null
      const nullNum = null as number | null
      result[r.normalized_name] = {
        id: r.id,
        canonicalName: r.canonical_name,
        normalizedName: r.normalized_name,
        entityType: (r.entity_type as CompanyDetail['entityType']) ?? 'unknown',
        pipelineStage: (r.pipeline_stage as CompanyDetail['pipelineStage']) ?? null,
        primaryDomain: r.primary_domain,
        industry: r.industry,
        city: r.city,
        state: r.state,
        arr: r.arr,
        raiseSize: r.raise_size,
        round: (r.round as CompanyDetail['round']) ?? null,
        // Required summary fields — populated with defaults
        description: nullStr, websiteUrl: nullStr, stage: nullStr, status: 'active',
        crmProvider: nullStr, crmCompanyId: nullStr, hqAddress: nullStr,
        linkedinCompanyUrl: nullStr, twitterHandle: nullStr, crunchbaseUrl: nullStr,
        angellistUrl: nullStr, targetCustomer: nullStr, businessModel: nullStr,
        productStage: nullStr, revenueModel: nullStr, foundingYear: nullNum,
        employeeCountRange: nullStr, burnRate: nullNum, runwayMonths: nullNum,
        totalFundingRaised: nullNum, lastFundingDate: nullStr, leadInvestor: nullStr,
        sourceType: nullStr, sourceEntityType: null, sourceEntityId: nullStr,
        relationshipOwner: nullStr, dealSource: nullStr,
        warmIntroSource: nullStr, referralContactId: nullStr, nextFollowupDate: nullStr,
        portfolioFund: null, investmentSize: nullStr, ownershipPct: nullStr,
        followonInvestmentSize: nullStr, totalInvested: nullStr,
        postMoneyValuation: nullNum, priority: null,
        includeInCompaniesView: false, classificationSource: 'manual',
        classificationConfidence: nullNum, contactCount: 0, lastTouchpoint: nullStr,
        meetingCount: 0, noteCount: 0, emailCount: 0,
        investmentMark: nullNum, investmentRound: null,
        initialInvestmentSecurity: nullStr, dateOfInitialInvestment: nullStr,
        initialRoundSize: nullNum, lastCompanyValuation: nullNum,
        followonCheck: nullNum, followonDate: nullStr,
        followonCheck2: nullNum, followonDate2: nullStr,
        coInvestorNames: nullStr,
        priorInvestorNames: nullStr, subsequentInvestorNames: nullStr,
        leadInvestorCompany: null,
        createdAt: '', updatedAt: '',
        themes: [],
        sourceEntityName: nullStr, coInvestorsList: [], priorInvestorsList: [], subsequentInvestorsList: [], coInvestedIn: [],
        coInvestorOverlaps: {},
        fieldSources: nullStr, keyTakeaways: nullStr
      } satisfies CompanyDetail
    }
  }
  return result
}

export function getCompany(companyId: string): CompanyDetail | null {
  const db = getDatabase()
  const row = db
    .prepare(`${baseCompanySelect('WHERE c.id = ?')} LIMIT 1`)
    .get(companyId) as CompanyRow | undefined
  if (!row) return null

  // field_sources and key_takeaways are excluded from baseCompanySelect (schema compat
  // with older DBs). Fetch them separately so they're only required in the detail view.
  // Each column is queried independently so a missing column doesn't block the other.
  try {
    const fsRow = db
      .prepare('SELECT field_sources FROM org_companies WHERE id = ?')
      .get(companyId) as { field_sources: string | null } | undefined
    if (fsRow) row.field_sources = fsRow.field_sources ?? null
  } catch {
    // Column doesn't exist yet (migration pending) — leave as null
  }
  try {
    const ktRow = db
      .prepare('SELECT key_takeaways FROM org_companies WHERE id = ?')
      .get(companyId) as { key_takeaways: string | null } | undefined
    if (ktRow) row.key_takeaways = ktRow.key_takeaways ?? null
  } catch {
    // Column doesn't exist yet (migration pending) — leave as null
  }

  const themes = db
    .prepare(`
      SELECT t.name
      FROM org_company_themes ct
      JOIN themes t ON t.id = ct.theme_id
      WHERE ct.company_id = ?
      ORDER BY ct.relevance_score DESC, t.name ASC
    `)
    .all(companyId) as { name: string }[]

  // Resolve source entity name (company or contact)
  let sourceEntityName: string | null = null
  if (row.source_entity_type === 'company' && row.source_entity_id) {
    const r = db
      .prepare('SELECT canonical_name FROM org_companies WHERE id = ?')
      .get(row.source_entity_id) as { canonical_name: string } | undefined
    sourceEntityName = r?.canonical_name ?? null
  } else if (row.source_entity_type === 'contact' && row.source_entity_id) {
    const r = db
      .prepare('SELECT full_name FROM contacts WHERE id = ?')
      .get(row.source_entity_id) as { full_name: string } | undefined
    sourceEntityName = r?.full_name ?? null
  }

  const { co_investor: coInvestorsList, prior_investor: priorInvestorsList, subsequent_investor: subsequentInvestorsList } = getCompanyInvestorsByType(db, companyId)
  const coInvestedIn = getCompanyCoInvestedIn(db, companyId)
  const coInvestorOverlaps = getCoInvestorOverlaps(companyId)

  return {
    ...rowToCompanySummary(row),
    themes: themes.map((v) => v.name),
    sourceEntityName,
    coInvestorsList,
    priorInvestorsList,
    subsequentInvestorsList,
    coInvestedIn,
    coInvestorOverlaps,
  }
}

function getCompanyInvestors(
  db: ReturnType<typeof getDatabase>,
  companyId: string,
  type: 'co_investor' | 'prior_investor' | 'subsequent_investor'
): Array<{ id: string; name: string; domain: string | null }> {
  try {
    const rows = db
      .prepare(`
        SELECT ci.investor_company_id AS id, oc.canonical_name AS name, oc.primary_domain AS domain
        FROM company_investors ci
        JOIN org_companies oc ON oc.id = ci.investor_company_id
        WHERE ci.company_id = ? AND ci.investor_type = ?
        ORDER BY ci.position, ci.created_at
      `)
      .all(companyId, type) as Array<{ id: string; name: string; domain: string | null }>
    return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain ?? null }))
  } catch {
    return []
  }
}

type InvestorType = 'co_investor' | 'prior_investor' | 'subsequent_investor'
type InvestorRow = { id: string; name: string; domain: string | null }

export function getCompanyInvestorsByType(
  db: ReturnType<typeof getDatabase>,
  companyId: string,
): Record<InvestorType, InvestorRow[]> {
  const empty: Record<InvestorType, InvestorRow[]> = {
    co_investor: [],
    prior_investor: [],
    subsequent_investor: [],
  }
  try {
    const rows = db
      .prepare(`
        SELECT
          ci.investor_company_id AS id,
          oc.canonical_name AS name,
          oc.primary_domain AS domain,
          ci.investor_type AS investor_type
        FROM company_investors ci
        JOIN org_companies oc ON oc.id = ci.investor_company_id
        WHERE ci.company_id = ?
          AND ci.investor_type IN ('co_investor', 'prior_investor', 'subsequent_investor')
        ORDER BY ci.investor_type, ci.position, ci.created_at
      `)
      .all(companyId) as Array<InvestorRow & { investor_type: InvestorType }>
    for (const r of rows) {
      empty[r.investor_type].push({ id: r.id, name: r.name, domain: r.domain ?? null })
    }
    return empty
  } catch {
    return empty
  }
}

function getCompanyCoInvestedIn(
  db: ReturnType<typeof getDatabase>,
  companyId: string
): Array<{ id: string; name: string; domain: string | null }> {
  try {
    const rows = db
      .prepare(`
        SELECT ci.company_id AS id, oc.canonical_name AS name, oc.primary_domain AS domain
        FROM company_investors ci
        JOIN org_companies oc ON oc.id = ci.company_id
        WHERE ci.investor_company_id = ? AND ci.investor_type = 'co_investor'
        ORDER BY ci.position, ci.created_at
      `)
      .all(companyId) as Array<{ id: string; name: string; domain: string | null }>
    return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain ?? null }))
  } catch {
    return []
  }
}

/**
 * For a portfolio company, count how many OTHER portfolio companies share each
 * of its co-investors. Phase 2C: powers "↑ N more" badges on co-investor chips
 * in the detail panel — turns relational data into investor-network intelligence.
 *
 *   Input:  companyId = "portco-1"
 *   Output: { "sequoia-id": 2, "accel-id": 1 }   (portco-1 + 2 others have Sequoia, etc.)
 *
 * Only counts overlap with portfolio-typed companies (entity_type = 'portfolio').
 * Does NOT include the input company itself.
 *
 * Returns empty object on DB error rather than throwing — UI gracefully omits badges.
 */
export function getCoInvestorOverlaps(companyId: string): Record<string, number> {
  const db = getDatabase()
  try {
    const rows = db
      .prepare(`
        SELECT
          ci_target.investor_company_id AS investor_id,
          COUNT(DISTINCT ci_other.company_id) AS overlap_count
        FROM company_investors ci_target
        JOIN company_investors ci_other
          ON ci_other.investor_company_id = ci_target.investor_company_id
          AND ci_other.investor_type = 'co_investor'
          AND ci_other.company_id != ci_target.company_id
        JOIN org_companies oc ON oc.id = ci_other.company_id
        WHERE ci_target.company_id = ?
          AND ci_target.investor_type = 'co_investor'
          AND oc.entity_type = 'portfolio'
        GROUP BY ci_target.investor_company_id
      `)
      .all(companyId) as Array<{ investor_id: string; overlap_count: number }>
    const out: Record<string, number> = {}
    for (const r of rows) {
      if (r.overlap_count > 0) out[r.investor_id] = r.overlap_count
    }
    return out
  } catch (err) {
    console.error('[org-company.repo] getCoInvestorOverlaps failed:', err)
    return {}
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
  const entityType = normalizeEntityType(data.entityType ?? 'unknown')
  const includeInCompaniesView = data.includeInCompaniesView ?? (entityType !== 'unknown')
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

// Maps TS property names to SQL column names for updateCompany
const COMPANY_UPDATABLE_FIELDS = {
  description: 'description',
  websiteUrl: 'website_url',
  city: 'city',
  state: 'state',
  stage: 'stage',
  status: 'status',
  foundingYear: 'founding_year',
  employeeCountRange: 'employee_count_range',
  hqAddress: 'hq_address',
  linkedinCompanyUrl: 'linkedin_company_url',
  twitterHandle: 'twitter_handle',
  crunchbaseUrl: 'crunchbase_url',
  angellistUrl: 'angellist_url',
  industry: 'industry',
  targetCustomer: 'target_customer',
  businessModel: 'business_model',
  productStage: 'product_stage',
  revenueModel: 'revenue_model',
  arr: 'arr',
  burnRate: 'burn_rate',
  runwayMonths: 'runway_months',
  lastFundingDate: 'last_funding_date',
  totalFundingRaised: 'total_funding_raised',
  leadInvestor: 'lead_investor',
  leadInvestorCompanyId: 'lead_investor_company_id',
  sourceType: 'source_type',
  sourceEntityType: 'source_entity_type',
  sourceEntityId: 'source_entity_id',
  relationshipOwner: 'relationship_owner',
  dealSource: 'deal_source',
  warmIntroSource: 'warm_intro_source',
  referralContactId: 'referral_contact_id',
  nextFollowupDate: 'next_followup_date',
  priority: 'priority',
  postMoneyValuation: 'post_money_valuation',
  raiseSize: 'raise_size',
  round: 'round',
  pipelineStage: 'pipeline_stage',
  fieldSources: 'field_sources',
  keyTakeaways: 'key_takeaways',
  portfolioFund: 'portfolio_fund',
  investmentSize: 'investment_size',
  ownershipPct: 'ownership_pct',
  followonInvestmentSize: 'followon_investment_size',
  totalInvested: 'total_invested',
  investmentMark: 'investment_mark',
  investmentRound: 'investment_round',
  initialInvestmentSecurity: 'initial_investment_security',
  dateOfInitialInvestment: 'date_of_initial_investment',
  initialRoundSize: 'initial_round_size',
  lastCompanyValuation: 'last_company_valuation',
  followonCheck: 'followon_check',
  followonDate: 'followon_date',
  followonCheck2: 'followon_check_2',
  followonDate2: 'followon_date_2',
} as const

type CompanyUpdatableKey = keyof typeof COMPANY_UPDATABLE_FIELDS

export function updateCompany(
  companyId: string,
  data: Partial<{
    canonicalName: string
    primaryDomain: string | null
    entityType: CompanyEntityType
    includeInCompaniesView: boolean
    classificationSource: 'manual' | 'auto'
    classificationConfidence: number | null
  } & Record<CompanyUpdatableKey, unknown>>,
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
  if (data.primaryDomain !== undefined) {
    normalizedPrimaryDomain = normalizeDomain(data.primaryDomain)
    sets.push('primary_domain = ?')
    params.push(normalizedPrimaryDomain)
  }
  // Auto-derive primary_domain from websiteUrl when the user edits the website
  // and primary_domain is currently empty OR malformed (no dot — e.g. a stale
  // "www" left over from a prior save-on-blur of a partially-typed URL). Skips
  // if the caller is also setting primaryDomain explicitly, or if the company
  // already has a valid domain set.
  if (data.websiteUrl !== undefined && data.primaryDomain === undefined) {
    const derived = extractDomainFromWebsiteUrl((data.websiteUrl as string | null) ?? null)
    if (derived) {
      const existing = db
        .prepare('SELECT primary_domain FROM org_companies WHERE id = ?')
        .get(companyId) as { primary_domain: string | null } | undefined
      const currentDomain = (existing?.primary_domain ?? '').trim()
      if (!currentDomain || !currentDomain.includes('.')) {
        normalizedPrimaryDomain = derived
        sets.push('primary_domain = ?')
        params.push(derived)
      }
    }
  }
  if (data.entityType !== undefined) {
    const normalizedEntityType = normalizeEntityType(data.entityType)
    sets.push('entity_type = ?')
    params.push(normalizedEntityType)

    // Keep include_in_companies_view aligned with classification when callers
    // only update entityType (common from the Company Detail type control).
    if (data.includeInCompaniesView === undefined) {
      sets.push('include_in_companies_view = ?')
      params.push(normalizedEntityType !== 'unknown' ? 1 : 0)
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

  // Handle all type-safe updatable fields via the const map
  for (const [tsProp, sqlCol] of Object.entries(COMPANY_UPDATABLE_FIELDS) as [CompanyUpdatableKey, string][]) {
    if (tsProp in data) {
      sets.push(`${sqlCol} = ?`)
      params.push((data as Record<string, unknown>)[tsProp] ?? null)
    }
  }

  if (sets.length > 0) {
    if (userId) {
      sets.push('updated_by_user_id = ?')
      params.push(userId)
    }
    sets.push("updated_at = datetime('now')")
    params.push(companyId)
    const result = db.prepare(`UPDATE org_companies SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    if (result.changes === 0) {
      console.error(`[updateCompany] UPDATE matched 0 rows for companyId=${companyId}`)
    }

    if (normalizedCanonicalName) {
      upsertCompanyAlias(db, companyId, normalizedCanonicalName, 'name')
    }
    if (normalizedPrimaryDomain) {
      for (const candidate of getDomainLookupCandidates(normalizedPrimaryDomain)) {
        upsertCompanyAlias(db, companyId, candidate, 'domain')
      }
    }
  }

  const detail = getCompany(companyId)
  if (detail && normalizedCanonicalName && detail.canonicalName !== normalizedCanonicalName) {
    console.error(
      `[updateCompany] Name mismatch after save: expected="${normalizedCanonicalName}" got="${detail.canonicalName}"`
    )
  }
  return detail
}

export function setCompanyInvestors(
  companyId: string,
  type: 'co_investor' | 'prior_investor' | 'subsequent_investor',
  /** Order matters — the array index becomes the persisted `position`. */
  investors: Array<{ id: string; name: string }>
): void {
  const db = getDatabase()
  db.transaction(() => {
    db.prepare('DELETE FROM company_investors WHERE company_id = ? AND investor_type = ?').run(companyId, type)
    investors.forEach((inv, idx) => {
      db.prepare(
        'INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position) VALUES (?, ?, ?, ?, ?)'
      ).run(randomUUID(), companyId, inv.id, type, idx)
    })
  })()
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

/**
 * Fast lookup of a company's canonical_name by domain (primary_domain or
 * alias_type='domain'). Used by callers that just need the display string —
 * avoids the heavy join inside getCompany().
 */
export function getCompanyCanonicalNameByDomain(domain: string): string | null {
  const id = findCompanyIdByDomain(domain)
  if (!id) return null
  const db = getDatabase()
  const row = db
    .prepare('SELECT canonical_name FROM org_companies WHERE id = ? LIMIT 1')
    .get(id) as { canonical_name: string } | undefined
  return row?.canonical_name ?? null
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
    entityType: 'unknown',
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

  // Direct read — entity_type is the only field needed, no need for the
  // heavy join that getCompany() does. This is on the hot path for
  // getCompanySuggestionsFromEmails which renders inline in the UI.
  const db = getDatabase()
  const row = db
    .prepare('SELECT entity_type FROM org_companies WHERE id = ? LIMIT 1')
    .get(companyId) as { entity_type: CompanyEntityType } | undefined
  if (!row || row.entity_type === 'unknown') return null
  return row.entity_type
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
  const includeInCompaniesView = data.includeInCompaniesView ?? (entityType !== 'unknown')
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

// ─── Merge: per-field conflict + auto-fill ────────────────────────────────────
//
// MERGEABLE_COLUMNS is the allowlist of org_companies columns that mergeCompanies
// is allowed to write to the target row. Excludes:
//   - id, canonical_name (target's name wins by definition; merging it would
//     defeat the purpose of choosing a keeper)
//   - normalized_name (derived from canonical_name elsewhere)
//   - include_in_companies_view (target wins — it represents UX intent)
//   - created_at / updated_at (timestamps managed elsewhere)
//   - any computed / denormalized list-view-only column
//
// If you add a new scalar column to org_companies, add it here so merges
// preserve its data. If you add a non-mergeable column (e.g. a derived /
// computed value), leave it out.
const MERGEABLE_COLUMNS = [
  'description', 'primary_domain', 'website_url', 'city', 'state', 'stage',
  'status', 'crm_provider', 'crm_company_id', 'priority',
  'post_money_valuation', 'raise_size', 'round', 'pipeline_stage',
  'founding_year', 'employee_count_range', 'hq_address',
  'linkedin_company_url', 'twitter_handle', 'crunchbase_url',
  'angellist_url', 'industry', 'target_customer', 'business_model',
  'product_stage', 'revenue_model', 'arr', 'burn_rate', 'runway_months',
  'last_funding_date', 'total_funding_raised', 'lead_investor',
  'source_type', 'source_entity_type', 'source_entity_id',
  'relationship_owner', 'deal_source', 'warm_intro_source',
  'referral_contact_id', 'next_followup_date',
  'portfolio_fund', 'investment_size', 'ownership_pct',
  'followon_investment_size', 'total_invested',
  'investment_mark', 'investment_round', 'initial_investment_security',
  'date_of_initial_investment', 'initial_round_size',
  'last_company_valuation', 'followon_check', 'followon_date',
  'followon_check2', 'followon_date2',
  'key_takeaways', 'field_sources',
  'lead_investor_company_id'
] as const

// Human labels for the merge review UI. Falls back to the column name if a
// label isn't listed (caller is expected to title-case for display).
const MERGEABLE_COLUMN_LABELS: Record<string, string> = {
  description: 'Description',
  primary_domain: 'Primary domain',
  website_url: 'Website',
  city: 'City',
  state: 'State',
  stage: 'Stage',
  status: 'Status',
  crm_provider: 'CRM provider',
  crm_company_id: 'CRM company ID',
  priority: 'Priority',
  post_money_valuation: 'Post-money valuation',
  raise_size: 'Raise size',
  round: 'Round',
  pipeline_stage: 'Pipeline stage',
  founding_year: 'Founding year',
  employee_count_range: 'Employee count',
  hq_address: 'HQ address',
  linkedin_company_url: 'LinkedIn URL',
  twitter_handle: 'X / Twitter',
  crunchbase_url: 'Crunchbase',
  angellist_url: 'AngelList',
  industry: 'Industry',
  target_customer: 'Target customer',
  business_model: 'Business model',
  product_stage: 'Product stage',
  revenue_model: 'Revenue model',
  arr: 'ARR',
  burn_rate: 'Burn rate',
  runway_months: 'Runway (months)',
  last_funding_date: 'Last funding date',
  total_funding_raised: 'Total funding raised',
  lead_investor: 'Lead investor (text)',
  source_type: 'Source type',
  source_entity_type: 'Source entity type',
  source_entity_id: 'Source entity ID',
  relationship_owner: 'Relationship owner',
  deal_source: 'Deal source',
  warm_intro_source: 'Warm intro source',
  referral_contact_id: 'Referral contact',
  next_followup_date: 'Next followup',
  portfolio_fund: 'Portfolio fund',
  investment_size: 'Investment size',
  ownership_pct: 'Ownership %',
  followon_investment_size: 'Follow-on size',
  total_invested: 'Total invested',
  investment_mark: 'Investment mark',
  investment_round: 'Investment round',
  initial_investment_security: 'Initial security',
  date_of_initial_investment: 'Initial investment date',
  initial_round_size: 'Initial round size',
  last_company_valuation: 'Last valuation',
  followon_check: 'Follow-on check',
  followon_date: 'Follow-on date',
  followon_check2: 'Follow-on check #2',
  followon_date2: 'Follow-on date #2',
  key_takeaways: 'Key takeaways',
  field_sources: 'Field sources (JSON)',
  lead_investor_company_id: 'Lead investor (linked)'
}

/** Empty: null, '', or whitespace-only string. Numbers count as non-empty. */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim().length === 0
  return false
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim()
  return false
}

/** Stringify a column value for display in the diff UI. */
function diffStringify(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/**
 * Returns the subset of MERGEABLE_COLUMNS that physically exist in the live
 * org_companies schema. Older DBs may be missing some columns added by ALTER
 * TABLE migrations; we introspect to stay tolerant. Same pattern as
 * listSuspectedDuplicateCompanies' richness expression construction.
 */
function getMergeableColumnsPresent(): string[] {
  const db = getDatabase()
  const cols = db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>
  const present = new Set(cols.map((c) => c.name))
  return MERGEABLE_COLUMNS.filter((c) => present.has(c))
}

export function getCompanyMergePreview(
  targetCompanyId: string,
  sourceCompanyId: string
): CompanyMergePreview {
  if (!targetCompanyId || !sourceCompanyId) {
    throw new Error('Both targetCompanyId and sourceCompanyId are required')
  }
  if (targetCompanyId === sourceCompanyId) {
    throw new Error('Target and source companies must be different')
  }

  const db = getDatabase()
  const cols = getMergeableColumnsPresent()
  const selectCols = ['id', 'canonical_name', ...cols].map((c) => `"${c}"`).join(', ')
  const target = db
    .prepare(`SELECT ${selectCols} FROM org_companies WHERE id = ? LIMIT 1`)
    .get(targetCompanyId) as Record<string, unknown> | undefined
  const source = db
    .prepare(`SELECT ${selectCols} FROM org_companies WHERE id = ? LIMIT 1`)
    .get(sourceCompanyId) as Record<string, unknown> | undefined
  if (!target) throw new Error('Target company not found')
  if (!source) throw new Error('Source company not found')

  const conflicts: MergeFieldDiff[] = []
  const autoFill: MergeFieldDiff[] = []
  for (const col of cols) {
    const tv = target[col]
    const sv = source[col]
    const tEmpty = isEmptyValue(tv)
    const sEmpty = isEmptyValue(sv)
    if (sEmpty) continue              // nothing to bring over
    if (tEmpty) {
      autoFill.push({
        column: col,
        label: MERGEABLE_COLUMN_LABELS[col] ?? col,
        targetValue: null,
        sourceValue: diffStringify(sv)
      })
      continue
    }
    if (valuesEqual(tv, sv)) continue  // both have the same value — silent
    conflicts.push({
      column: col,
      label: MERGEABLE_COLUMN_LABELS[col] ?? col,
      targetValue: diffStringify(tv),
      sourceValue: diffStringify(sv)
    })
  }

  // Array unions — pre-compute counts of source rows that would be added to
  // target. Themes/aliases use INSERT OR IGNORE in mergeCompanies, so the
  // "added" count is rows on source that don't already exist on target by the
  // same unique-key columns.
  const arrayUnions: Array<{ name: string; addedCount: number }> = []

  const themeAdded = db.prepare(`
    SELECT COUNT(*) AS n FROM org_company_themes s
    WHERE s.company_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM org_company_themes t WHERE t.company_id = ? AND t.theme_id = s.theme_id
      )
  `).get(sourceCompanyId, targetCompanyId) as { n: number }
  if (themeAdded.n > 0) arrayUnions.push({ name: 'Themes', addedCount: themeAdded.n })

  const aliasAdded = db.prepare(`
    SELECT COUNT(*) AS n FROM org_company_aliases s
    WHERE s.company_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM org_company_aliases t
        WHERE t.company_id = ? AND t.alias_value = s.alias_value AND t.alias_type = s.alias_type
      )
  `).get(sourceCompanyId, targetCompanyId) as { n: number }
  if (aliasAdded.n > 0) arrayUnions.push({ name: 'Aliases', addedCount: aliasAdded.n })

  const investorAdded = db.prepare(`
    SELECT COUNT(*) AS n FROM company_investors s
    WHERE (s.company_id = ? OR s.investor_company_id = ?)
      AND s.company_id != s.investor_company_id
      AND NOT EXISTS (
        SELECT 1 FROM company_investors t
        WHERE t.company_id = CASE WHEN s.company_id = ? THEN ? ELSE s.company_id END
          AND t.investor_company_id = CASE WHEN s.investor_company_id = ? THEN ? ELSE s.investor_company_id END
          AND t.investor_type = s.investor_type
      )
  `).get(sourceCompanyId, sourceCompanyId, sourceCompanyId, targetCompanyId, sourceCompanyId, targetCompanyId) as { n: number }
  if (investorAdded.n > 0) arrayUnions.push({ name: 'Investor relations', addedCount: investorAdded.n })

  return {
    target: { id: targetCompanyId, canonicalName: String(target.canonical_name) },
    source: { id: sourceCompanyId, canonicalName: String(source.canonical_name) },
    conflicts,
    autoFill,
    arrayUnions
  }
}

export function mergeCompanies(targetCompanyId: string, sourceCompanyId: string, fieldOverrides?: MergeFieldOverrides): CompanyMergeResult {
  if (!targetCompanyId || !sourceCompanyId) {
    throw new Error('Both targetCompanyId and sourceCompanyId are required')
  }
  if (targetCompanyId === sourceCompanyId) {
    throw new Error('Target and source companies must be different')
  }

  const db = getDatabase()
  // Pull every mergeable column on both rows so we can compute the field
  // resolution before we relink. Columns that don't exist in this DB are
  // skipped via the live introspection (see getMergeableColumnsPresent).
  const mergeableCols = getMergeableColumnsPresent()
  const selectCols = ['id', 'canonical_name', ...mergeableCols].map((c) => `"${c}"`).join(', ')
  const target = db
    .prepare(`SELECT ${selectCols} FROM org_companies WHERE id = ? LIMIT 1`)
    .get(targetCompanyId) as Record<string, unknown> | undefined
  const source = db
    .prepare(`SELECT ${selectCols} FROM org_companies WHERE id = ? LIMIT 1`)
    .get(sourceCompanyId) as Record<string, unknown> | undefined

  if (!target) throw new Error('Target company not found')
  if (!source) throw new Error('Source company not found')

  // Compute the FINAL value for each mergeable column.
  //
  //   precedence:  fieldOverrides[col]   (renderer-supplied: explicit pick)
  //              > source value          (auto-fill: target empty, source has value)
  //              > target value          (status quo: target wins on conflict)
  //
  // Only columns whose final value differs from the current target value are
  // included in `valueWrites`, so equal-value rows don't generate spurious UPDATEs.
  const valueWrites: Record<string, unknown> = {}
  for (const col of mergeableCols) {
    const tv = target[col]
    const sv = source[col]
    const hasOverride = fieldOverrides !== undefined && Object.prototype.hasOwnProperty.call(fieldOverrides, col)
    let finalValue: unknown
    if (hasOverride) {
      finalValue = (fieldOverrides as MergeFieldOverrides)[col]
    } else if (isEmptyValue(tv) && !isEmptyValue(sv)) {
      finalValue = sv
    } else {
      finalValue = tv
    }
    if (!valuesEqual(finalValue, tv)) valueWrites[col] = finalValue
  }
  // Cast to a stable shape used downstream.
  const targetSummary = { id: String(target.id), canonical_name: String(target.canonical_name) }
  const sourceSummary = { id: String(source.id), canonical_name: String(source.canonical_name) }

  // Collect every domain the source owns (primary_domain + alias domains).
  // Used inside the transaction to refresh the legacy `companies` cache so
  // future calendar ingest by these domains returns the target's
  // canonical_name. Read BEFORE the transaction starts: source's aliases get
  // moved/deleted inside.
  const sourceAliasDomainRows = db
    .prepare(
      `SELECT alias_value FROM org_company_aliases ` +
      `WHERE company_id = ? AND alias_type = 'domain'`
    )
    .all(sourceCompanyId) as Array<{ alias_value: string }>
  const sourceCacheDomains = [
    source.primary_domain,
    ...sourceAliasDomainRows.map((r) => r.alias_value)
  ]
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => d.toLowerCase())

  const relinked = {
    meetingLinks: 0,
    emailLinks: 0,
    contactPrimaries: 0,
    contactLinks: 0,
    deals: 0,
    notes: 0,
    conversations: 0,
    memos: 0,
    themes: 0,
    theses: 0,
    artifacts: 0,
    aliases: 0
  }

  const tx = db.transaction(() => {
    // Capture affected meeting IDs before relinking (for denormalized cache update)
    const affectedMeetingIds = db
      .prepare('SELECT meeting_id FROM meeting_company_links WHERE company_id = ?')
      .all(sourceCompanyId) as { meeting_id: string }[]

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

    // Update denormalized meetings.companies JSON cache: replace source name with target name
    for (const { meeting_id } of affectedMeetingIds) {
      const row = db.prepare('SELECT companies FROM meetings WHERE id = ?').get(meeting_id) as { companies: string | null } | undefined
      if (!row?.companies) continue
      try {
        const names: string[] = JSON.parse(row.companies)
        const srcLower = sourceSummary.canonical_name.toLowerCase()
        const hasSource = names.some(n => n.toLowerCase() === srcLower)
        if (!hasSource) continue
        const tgtLower = targetSummary.canonical_name.toLowerCase()
        const hasTarget = names.some(n => n.toLowerCase() === tgtLower)
        const updated = names
          .filter(n => n.toLowerCase() !== srcLower)
          .concat(hasTarget ? [] : [targetSummary.canonical_name])
        db.prepare('UPDATE meetings SET companies = ? WHERE id = ?')
          .run(JSON.stringify(updated), meeting_id)
      } catch { /* skip malformed JSON */ }
    }

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

    // notes has UNIQUE(company_id, source_meeting_id) WHERE both NOT NULL (migration 082).
    // If both companies have a note from the same meeting, the UPDATE below would collide.
    // Drop the source-side duplicates first; the target's note (already on the kept company) wins.
    db.prepare(`
      DELETE FROM notes
      WHERE company_id = ?
        AND source_meeting_id IS NOT NULL
        AND source_meeting_id IN (
          SELECT source_meeting_id FROM notes
          WHERE company_id = ?
            AND source_meeting_id IS NOT NULL
        )
    `).run(sourceCompanyId, targetCompanyId)

    relinked.notes = db
      .prepare(`
        UPDATE notes
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

    // company_conversations was dropped in migration 079 — skip the relink.
    relinked.conversations = 0

    relinked.memos = db
      .prepare(`
        UPDATE investment_memos
        SET company_id = ?, updated_at = datetime('now')
        WHERE company_id = ?
      `)
      .run(targetCompanyId, sourceCompanyId).changes

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

    // Per-field merge: write any computed value changes onto the target row.
    // Both auto-fill (target empty, source has value) and explicit
    // fieldOverrides land here. updated_at is bumped in the same statement so
    // the second UPDATE below isn't needed when valueWrites is non-empty.
    const writeKeys = Object.keys(valueWrites)
    if (writeKeys.length > 0) {
      const setClause = writeKeys.map((c) => `"${c}" = ?`).join(', ')
      const params = writeKeys.map((c) => valueWrites[c] as unknown)
      db.prepare(
        `UPDATE org_companies SET ${setClause}, updated_at = datetime('now') WHERE id = ?`
      ).run(...params, targetCompanyId)
    } else {
      db.prepare(`UPDATE org_companies SET updated_at = datetime('now') WHERE id = ?`)
        .run(targetCompanyId)
    }

    // Investor relinks (no FK CASCADE will preserve these — we have to do it
    // manually before source is deleted). Three pieces:
    //   (a) other companies that pointed at source as their lead investor
    //   (b) company_investors rows where source is the company_id
    //   (c) company_investors rows where source is the investor_company_id
    // INSERT OR IGNORE on the unique (company_id, investor_company_id, investor_type)
    // dedupes against existing target rows. Self-edges are filtered with `!= ?`.
    //
    // Both the column and table are added by later migrations (076, 056); guard
    // against older DBs (and minimal test fixtures) by introspecting first.
    const hasLeadInvestorCompanyId = (db
      .prepare(`PRAGMA table_info(org_companies)`)
      .all() as Array<{ name: string }>)
      .some((c) => c.name === 'lead_investor_company_id')
    if (hasLeadInvestorCompanyId) {
      db.prepare(
        `UPDATE org_companies SET lead_investor_company_id = ?, updated_at = datetime('now') WHERE lead_investor_company_id = ? AND id != ?`
      ).run(targetCompanyId, sourceCompanyId, targetCompanyId)
    }
    const hasCompanyInvestors = !!db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='company_investors'`)
      .get()
    if (hasCompanyInvestors) {
      db.prepare(`
        INSERT OR IGNORE INTO company_investors (id, company_id, investor_company_id, investor_type, position, created_at)
        SELECT lower(hex(randomblob(16))), ?, investor_company_id, investor_type, position, created_at
        FROM company_investors WHERE company_id = ? AND investor_company_id != ?
      `).run(targetCompanyId, sourceCompanyId, targetCompanyId)
      db.prepare(`
        INSERT OR IGNORE INTO company_investors (id, company_id, investor_company_id, investor_type, position, created_at)
        SELECT lower(hex(randomblob(16))), company_id, ?, investor_type, position, created_at
        FROM company_investors WHERE investor_company_id = ? AND company_id != ?
      `).run(targetCompanyId, sourceCompanyId, targetCompanyId)
    }

    // Search-dropdown cache cleanup. Source's alias domains were moved to the
    // target above (line 1761-1767), so any cache row keyed by an old source
    // domain is now a legitimate target row. We only delete cache rows whose
    // display_name still reads as the source name — those would surface a
    // company that no longer exists. Case-insensitive because email-parse-derived
    // cache rows often store name variants.
    // Cache rows keyed by the source's domains now belong to the target —
    // rewrite their display_name so future calendar ingest from these domains
    // surfaces the kept company's name instead of the merged-away one.
    // (Bumping enriched_at lets future enrich callers see this row was just
    // refreshed.) Do this BEFORE the name-based DELETE below so domain-keyed
    // rows whose display_name happens to be the source name get rewritten,
    // not deleted.
    if (sourceCacheDomains.length > 0) {
      const placeholders = sourceCacheDomains.map(() => '?').join(', ')
      db.prepare(
        `UPDATE companies SET display_name = ?, enriched_at = datetime('now') WHERE domain IN (${placeholders})`
      ).run(targetSummary.canonical_name, ...sourceCacheDomains)
    }

    // Catch any leftover cache rows keyed by an unknown domain whose
    // display_name still reads as the source name.
    db.prepare('DELETE FROM companies WHERE display_name = ? COLLATE NOCASE')
      .run(sourceSummary.canonical_name)

    db.prepare('DELETE FROM org_companies WHERE id = ?').run(sourceCompanyId)
  })

  tx()

  return {
    targetCompanyId,
    sourceCompanyId,
    relinked
  }
}

export function listSuspectedDuplicateCompanies(limitGroups = 30): CompanyDuplicateGroup[] {
  const db = getDatabase()
  const normalizedLimit = Number.isFinite(limitGroups)
    ? Math.max(1, Math.min(Math.floor(limitGroups), 200))
    : 30
  // populated_field_count = sum of CASE-WHEN-NOT-NULL over enrichment columns that
  // actually exist in this DB (introspected from PRAGMA so older DBs missing some
  // ALTER TABLE migrations don't fail). Used as a richness proxy when the user picks
  // which duplicate to keep. Activity counts (meetings/emails/notes) supplement it.
  const TEXT_RICHNESS_COLUMNS = [
    'description', 'city', 'state', 'stage', 'employee_count_range',
    'linkedin_company_url', 'twitter_handle', 'crunchbase_url', 'sector',
    'target_customer', 'business_model', 'product_stage', 'revenue_model',
    'lead_investor', 'co_investors', 'round', 'key_takeaways'
  ]
  const NUMERIC_RICHNESS_COLUMNS = ['founding_year', 'post_money_valuation', 'raise_size']
  const existingColumns = new Set(
    (db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>).map((r) => r.name)
  )
  const richnessExpressions: string[] = []
  for (const col of TEXT_RICHNESS_COLUMNS) {
    if (existingColumns.has(col)) {
      richnessExpressions.push(`(CASE WHEN c.${col} IS NOT NULL AND TRIM(c.${col}) <> '' THEN 1 ELSE 0 END)`)
    }
  }
  for (const col of NUMERIC_RICHNESS_COLUMNS) {
    if (existingColumns.has(col)) {
      richnessExpressions.push(`(CASE WHEN c.${col} IS NOT NULL THEN 1 ELSE 0 END)`)
    }
  }
  const richnessSql = richnessExpressions.length > 0 ? richnessExpressions.join(' + ') : '0'

  const rows = db
    .prepare(`
      SELECT
        c.id,
        c.canonical_name,
        c.primary_domain,
        c.website_url,
        c.entity_type,
        c.pipeline_stage,
        c.updated_at,
        (${richnessSql}) AS populated_field_count,
        (SELECT COUNT(*) FROM meeting_company_links WHERE company_id = c.id) AS meeting_count,
        (SELECT COUNT(*) FROM email_company_links   WHERE company_id = c.id) AS email_count,
        (SELECT COUNT(*) FROM notes                 WHERE company_id = c.id) AS note_count
      FROM org_companies c
      ORDER BY datetime(c.updated_at) DESC
    `)
    .all() as Array<{
    id: string
    canonical_name: string
    primary_domain: string | null
    website_url: string | null
    entity_type: CompanyEntityType
    pipeline_stage: CompanyPipelineStage | null
    updated_at: string
    populated_field_count: number
    meeting_count: number
    email_count: number
    note_count: number
  }>

  const groupsByDomain = new Map<string, CompanyDuplicateSummary[]>()
  for (const row of rows) {
    const domainKey = normalizeDomain(row.primary_domain) || normalizeDomain(row.website_url)
    if (!domainKey) continue
    const summary: CompanyDuplicateSummary = {
      id: row.id,
      canonicalName: row.canonical_name,
      primaryDomain: row.primary_domain,
      websiteUrl: row.website_url,
      entityType: row.entity_type,
      pipelineStage: row.pipeline_stage,
      updatedAt: row.updated_at,
      populatedFieldCount: row.populated_field_count,
      meetingCount: row.meeting_count,
      emailCount: row.email_count,
      noteCount: row.note_count
    }
    const existing = groupsByDomain.get(domainKey)
    if (existing) {
      existing.push(summary)
    } else {
      groupsByDomain.set(domainKey, [summary])
    }
  }

  const groups: CompanyDuplicateGroup[] = []
  const domainGroupedIds = new Set<string>()

  for (const [domainKey, companies] of groupsByDomain.entries()) {
    if (companies.length < 2) continue
    const sortedCompanies = [...companies].sort(compareDuplicateCompanies)
    const suggestedKeep = sortedCompanies[0]
    if (!suggestedKeep) continue
    sortedCompanies.forEach((c) => domainGroupedIds.add(c.id))

    groups.push({
      key: `domain:${domainKey}`,
      domain: domainKey,
      reason: `Same domain: ${domainKey}`,
      suggestedKeepCompanyId: suggestedKeep.id,
      companies: sortedCompanies
    })
  }

  // ── Fuzzy name pass + cross-pass merge with domain groups ───────────────────
  //
  // Fuzzy candidates = ALL rows (not just ungrouped). After Jaro-Winkler
  // clustering, each cluster (size ≥ 2) is routed by overlap with existing
  // domain groups:
  //
  //   ┌─ overlaps 0 domain groups ─────► emit as fuzzy-only group
  //   ├─ overlaps exactly 1 domain group ─► extend that group
  //   │     - append fuzzy-only members (skip ids already in the group)
  //   │     - recompute suggestedKeep via compareDuplicateCompanies
  //   │     - set confidence; reason becomes "Same domain + similar names"
  //   ├─ overlaps 2+ domain groups ──► do nothing (don't merge domains)
  //   └─ size after dedup < 2 ────► skip
  //
  // Perf: skip JW pair comparison when both normalized names map only to
  // companies already in domain groups — those pairs can never produce a new
  // emit (same domain group is already clustered; cross-domain-group merging
  // is forbidden by the "2+" rule).
  //
  // Dedup invariant: emittedCompanyIds Set ensures a company appears in at
  // most one output group.

  const rowsById = new Map<string, typeof rows[0]>()
  for (const row of rows) rowsById.set(row.id, row)

  const normalizedToIds = new Map<string, string[]>()
  for (const row of rows) {
    const norm = normalizeCompanyName(row.canonical_name || '')
    if (!norm) continue
    const list = normalizedToIds.get(norm)
    if (list) list.push(row.id)
    else normalizedToIds.set(norm, [row.id])
  }
  const candidateNames = [...normalizedToIds.keys()]

  const emittedCompanyIds = new Set<string>(domainGroupedIds)
  const companyToDomainGroupIdx = new Map<string, number>()
  groups.forEach((g, idx) => {
    for (const c of g.companies) companyToDomainGroupIdx.set(c.id, idx)
  })

  const allInDomainGroup = (name: string): boolean => {
    const ids = normalizedToIds.get(name) || []
    return ids.length > 0 && ids.every((id) => domainGroupedIds.has(id))
  }

  const buildSummary = (id: string): CompanyDuplicateSummary | null => {
    const row = rowsById.get(id)
    if (!row) return null
    return {
      id: row.id,
      canonicalName: row.canonical_name,
      primaryDomain: row.primary_domain,
      websiteUrl: row.website_url,
      entityType: row.entity_type,
      pipelineStage: row.pipeline_stage,
      updatedAt: row.updated_at,
      populatedFieldCount: row.populated_field_count,
      meetingCount: row.meeting_count,
      emailCount: row.email_count,
      noteCount: row.note_count
    }
  }

  if (candidateNames.length > 0 && candidateNames.length <= MAX_FUZZY_CANDIDATES) {
    const uf = new UnionFind()
    const maxSimByPair = new Map<string, number>()

    for (let i = 0; i < candidateNames.length; i++) {
      const ni = candidateNames[i]!
      const niAllDomain = allInDomainGroup(ni)
      for (let j = i + 1; j < candidateNames.length; j++) {
        const nj = candidateNames[j]!
        if (niAllDomain && allInDomainGroup(nj)) continue
        const sim = jaroWinkler(ni, nj)
        if (sim >= FUZZY_THRESHOLD) {
          uf.union(ni, nj)
          const pairKey = `${ni}\0${nj}`
          maxSimByPair.set(pairKey, Math.max(maxSimByPair.get(pairKey) ?? 0, sim))
        }
      }
    }

    for (const [, cluster] of uf.clusters()) {
      if (cluster.length < 2) continue

      const clusterRowIds = new Set<string>()
      for (const name of cluster) {
        for (const id of normalizedToIds.get(name) || []) clusterRowIds.add(id)
      }
      if (clusterRowIds.size < 2) continue

      const overlappedGroupIndexes = new Set<number>()
      for (const id of clusterRowIds) {
        const idx = companyToDomainGroupIdx.get(id)
        if (idx !== undefined) overlappedGroupIndexes.add(idx)
      }

      let maxSim = 0
      for (let i = 0; i < cluster.length; i++) {
        for (let j = i + 1; j < cluster.length; j++) {
          const a = cluster[i]!
          const b = cluster[j]!
          const sim = maxSimByPair.get(`${a}\0${b}`) ?? maxSimByPair.get(`${b}\0${a}`) ?? 0
          if (sim > maxSim) maxSim = sim
        }
      }
      const confidence = Math.round(maxSim * 100)

      if (overlappedGroupIndexes.size >= 2) {
        // Don't merge across domain groups.
        continue
      }

      if (overlappedGroupIndexes.size === 0) {
        const summaries: CompanyDuplicateSummary[] = []
        for (const id of clusterRowIds) {
          if (emittedCompanyIds.has(id)) continue
          const summary = buildSummary(id)
          if (summary) summaries.push(summary)
        }
        if (summaries.length < 2) continue
        const sorted = [...summaries].sort(compareDuplicateCompanies)
        sorted.forEach((s) => emittedCompanyIds.add(s.id))
        groups.push({
          key: `fuzzy-name:${[...cluster].sort().join('|')}`,
          domain: null,
          reason: `Similar names (~${confidence}% match)`,
          suggestedKeepCompanyId: sorted[0]!.id,
          companies: sorted,
          confidence
        })
      } else {
        const groupIdx = overlappedGroupIndexes.values().next().value as number
        const existing = groups[groupIdx]!
        const existingIds = new Set(existing.companies.map((c) => c.id))
        const additions: CompanyDuplicateSummary[] = []
        for (const id of clusterRowIds) {
          if (existingIds.has(id)) continue
          if (emittedCompanyIds.has(id)) continue
          const summary = buildSummary(id)
          if (summary) additions.push(summary)
        }
        if (additions.length === 0) continue
        const merged = [...existing.companies, ...additions].sort(compareDuplicateCompanies)
        additions.forEach((s) => emittedCompanyIds.add(s.id))
        groups[groupIdx] = {
          ...existing,
          companies: merged,
          suggestedKeepCompanyId: merged[0]!.id,
          reason: `Same domain: ${existing.domain} + similar names (~${confidence}% match)`,
          confidence
        }
      }
    }
  } else if (candidateNames.length > MAX_FUZZY_CANDIDATES) {
    console.warn(
      `[dedup] fuzzy pass skipped: ${candidateNames.length} companies > MAX_FUZZY_CANDIDATES (${MAX_FUZZY_CANDIDATES}); some duplicates may be missed`
    )
  }

  groups.sort((a, b) => {
    if (a.companies.length !== b.companies.length) {
      return b.companies.length - a.companies.length
    }
    return a.key.localeCompare(b.key)
  })

  return groups.slice(0, normalizedLimit)
}

export function applyCompanyDedupDecisions(
  decisions: CompanyDedupDecision[],
  userId: string | null = null
): CompanyDedupApplyResult {
  const db = getDatabase()
  const result: CompanyDedupApplyResult = {
    reviewedGroups: 0,
    mergedGroups: 0,
    deletedGroups: 0,
    skippedGroups: 0,
    mergedCompanies: 0,
    deletedCompanies: 0,
    failures: []
  }

  if (!Array.isArray(decisions) || decisions.length === 0) {
    return result
  }

  for (const decision of decisions) {
    const groupKey = (decision.groupKey || '').trim() || 'unknown-group'
    const action: CompanyDedupAction = decision.action
    result.reviewedGroups += 1

    if (action === 'skip') {
      result.skippedGroups += 1
      continue
    }

    try {
      if (action !== 'delete' && action !== 'merge') {
        throw new Error(`Unsupported action: ${action}`)
      }

      const keepCompanyId = (decision.keepCompanyId || '').trim()
      if (!keepCompanyId) throw new Error('keepCompanyId is required')

      const normalizedCompanyIds = [...new Set(
        (decision.companyIds || [])
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )]

      if (normalizedCompanyIds.length < 2) {
        throw new Error('At least two companies are required for de-duplication')
      }
      if (!normalizedCompanyIds.includes(keepCompanyId)) {
        throw new Error('keepCompanyId must be included in companyIds')
      }

      const placeholders = normalizedCompanyIds.map(() => '?').join(', ')
      const existing = db
        .prepare(`
          SELECT id
          FROM org_companies
          WHERE id IN (${placeholders})
        `)
        .all(...normalizedCompanyIds) as Array<{ id: string }>
      if (existing.length !== normalizedCompanyIds.length) {
        throw new Error('One or more companies no longer exist')
      }

      const sourceIds = normalizedCompanyIds.filter((id) => id !== keepCompanyId)
      if (sourceIds.length === 0) {
        result.skippedGroups += 1
        continue
      }

      if (action === 'delete') {
        for (const id of sourceIds) deleteCompany(id)
        result.deletedGroups += 1
        result.deletedCompanies += sourceIds.length
        continue
      }

      for (const id of sourceIds) {
        mergeCompanies(keepCompanyId, id)
        result.mergedCompanies += 1
      }
      result.mergedGroups += 1
    } catch (err) {
      result.failures.push({
        groupKey,
        action,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  return result
}

/**
 * deleteCompany — cleanup waterfall for a single company row.
 *
 * Tables related to a company are cleaned by one of four mechanisms:
 *
 *   (a) FK CASCADE auto                 — declared in migrations, fires when the
 *                                         org_companies row is deleted.
 *       meeting_company_links, email_company_links, org_company_contacts,
 *       deals, investment_memos (+ versions cascade via memo_id),
 *       investment_memo_versions, org_company_themes, theses, artifacts(*),
 *       org_company_aliases, company_investors (both directions),
 *       partner_meeting_items, company_decision_logs.
 *
 *   (b) FK SET NULL auto                — column nulled by FK on parent delete.
 *       contacts.primary_company_id, notes.company_id, tasks.company_id,
 *       artifacts.company_id (some rows).
 *
 *   (c) Explicit DELETE in this fn      — kept for historical reasons; redundant
 *                                         with (a) but harmless.
 *
 *   (d) No FK / manual cleanup          — added in this fn because the schema
 *                                         has no FK and orphans would be left:
 *       company_flagged_files          (mig 035 — no FK)
 *       chat_sessions (context_kind='company' AND context_id=id)  (mig 078 — no FK)
 *       org_companies.lead_investor_company_id self-reference     (mig 076 — no FK)
 *       companies cache table          (legacy mig 008 — no FK; populated from
 *                                       email/meeting parsing)
 *       meetings.companies JSON        (mig 008 — text column, scrubbed by name)
 *       meetings.dismissed_companies   (mig 071 — text column, scrubbed by name)
 *
 * If you add a new table with a `company_id` column, choose between adding an
 * `ON DELETE CASCADE`/`SET NULL` FK (preferred, lands in bucket (a)/(b)) or
 * extending bucket (d) below.
 */
export function deleteCompany(companyId: string): void {
  if (!companyId) throw new Error('companyId is required')

  const db = getDatabase()
  const company = db
    .prepare('SELECT id, canonical_name, primary_domain FROM org_companies WHERE id = ? LIMIT 1')
    .get(companyId) as { id: string; canonical_name: string; primary_domain: string | null } | undefined
  if (!company) throw new Error('Company not found')

  // Wildcard-escape for LIKE pre-filter on JSON columns. Names rarely contain
  // %/_/\ but it costs nothing to be correct, and COLLATE NOCASE handles
  // mixed-case stored variants.
  const escapedName = company.canonical_name.replace(/[\\%_]/g, '\\$&')
  const lowerName = company.canonical_name.toLowerCase()

  // Collect every domain we need to scrub from the legacy `companies` cache.
  // Cache is keyed by domain, populated from email parsing. A company has
  // its primary_domain plus 0+ alias domains. Lowercase before bind because
  // cache.domain is canonically lowercased on write (see extractDomainFromEmail).
  // Read before the transaction starts — better-sqlite3 is synchronous, so this
  // is safe and consistent with how `company` is fetched above.
  const aliasDomainRows = db
    .prepare(
      `SELECT alias_value FROM org_company_aliases ` +
      `WHERE company_id = ? AND alias_type = 'domain'`
    )
    .all(companyId) as Array<{ alias_value: string }>
  const cacheDomains = [
    company.primary_domain,
    ...aliasDomainRows.map((r) => r.alias_value)
  ]
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .map((d) => d.toLowerCase())

  // Strip the canonical name from a JSON-array-shaped TEXT column on `meetings`.
  // N+1 by design — single-user CRM scale, deletes are rare.
  function scrubMeetingsJsonColumn(column: 'companies' | 'dismissed_companies') {
    const selectSql =
      `SELECT id, ${column} AS arr FROM meetings ` +
      `WHERE ${column} IS NOT NULL AND ${column} LIKE ? ESCAPE '\\' COLLATE NOCASE`
    const updateSql = `UPDATE meetings SET ${column} = ? WHERE id = ?`
    const rows = db.prepare(selectSql).all(`%${escapedName}%`) as Array<{ id: string; arr: string }>
    const updateStmt = db.prepare(updateSql)
    for (const row of rows) {
      let parsed: unknown
      try { parsed = JSON.parse(row.arr) } catch { continue }
      if (!Array.isArray(parsed)) continue
      const filtered = parsed.filter(
        (c) => typeof c === 'string' && c.toLowerCase() !== lowerName
      )
      if (filtered.length === parsed.length) continue
      updateStmt.run(filtered.length ? JSON.stringify(filtered) : null, row.id)
    }
  }

  const tx = db.transaction(() => {
    // (c) Explicit DELETEs — redundant with FK CASCADE/SET NULL but kept for
    //     readability of what gets touched.
    db.prepare('DELETE FROM meeting_company_links WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM email_company_links WHERE company_id = ?').run(companyId)
    db.prepare('UPDATE contacts SET primary_company_id = NULL, updated_at = datetime(\'now\') WHERE primary_company_id = ?').run(companyId)
    db.prepare('DELETE FROM org_company_contacts WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM deals WHERE company_id = ?').run(companyId)
    db.prepare("UPDATE notes SET company_id = NULL, updated_at = datetime('now') WHERE company_id = ?").run(companyId)
    // company_conversations was dropped in migration 079.
    // Delete memo versions first, then memos
    db.prepare('DELETE FROM investment_memo_versions WHERE memo_id IN (SELECT id FROM investment_memos WHERE company_id = ?)').run(companyId)
    db.prepare('DELETE FROM investment_memos WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM org_company_themes WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM theses WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM artifacts WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM org_company_aliases WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM tasks WHERE company_id = ?').run(companyId)

    // (d) No-FK / manual cleanup.
    db.prepare('DELETE FROM company_flagged_files WHERE company_id = ?').run(companyId)
    db.prepare("DELETE FROM chat_sessions WHERE context_kind = 'company' AND context_id = ?").run(companyId)
    // Self-reference column on org_companies has no FK — clear dangling
    // pointers from OTHER companies before deleting the target row.
    db.prepare(
      "UPDATE org_companies SET lead_investor_company_id = NULL, lead_investor = NULL, updated_at = datetime('now') WHERE lead_investor_company_id = ?"
    ).run(companyId)
    // Search-dropdown cache (legacy companies table, no FK to org_companies).
    // Two passes: by display_name (case-insensitive — cache rows from email
    // parsing often store lowercase variants) and by every owned domain
    // (primary_domain + alias domains).
    db.prepare('DELETE FROM companies WHERE display_name = ? COLLATE NOCASE').run(company.canonical_name)
    if (cacheDomains.length > 0) {
      const placeholders = cacheDomains.map(() => '?').join(', ')
      db.prepare(`DELETE FROM companies WHERE domain IN (${placeholders})`).run(...cacheDomains)
    }
    scrubMeetingsJsonColumn('companies')
    scrubMeetingsJsonColumn('dismissed_companies')

    db.prepare('DELETE FROM org_companies WHERE id = ?').run(companyId)
  })

  tx()
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

export function linkMeetingsForContactCompany(
  companyId: string,
  contactEmails: string[],
  userId: string | null = null
): number {
  const normalized = contactEmails
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (normalized.length === 0) return 0

  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT DISTINCT m.id
      FROM meetings m, json_each(COALESCE(m.attendee_emails, '[]')) e
      WHERE lower(trim(e.value)) IN (${normalized.map(() => '?').join(', ')})
    `)
    .all(...normalized) as Array<{ id: string }>

  for (const row of rows) {
    linkMeetingCompany(row.id, companyId, 0.8, 'contact_association', userId)
  }
  return rows.length
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
      FROM meetings m
      WHERE m.id IN (
        SELECT l.meeting_id FROM meeting_company_links l WHERE l.company_id = ?
        UNION
        SELECT m2.id FROM meetings m2
        JOIN contacts c ON c.primary_company_id = ?
        WHERE c.email IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM json_each(COALESCE(m2.attendee_emails, '[]')) e
            WHERE lower(trim(e.value)) = lower(trim(c.email))
          )
      )
      ORDER BY datetime(m.date) DESC
    `)
    .all(companyId, companyId) as Array<{
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

export function listCompanyMeetingSummaryPaths(companyId: string): Array<{ meetingId: string; title: string; date: string; summaryPath: string }> {
  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT m.id, m.title, m.date, m.summary_path
      FROM meetings m
      WHERE m.summary_path IS NOT NULL
        AND m.id IN (
          SELECT l.meeting_id FROM meeting_company_links l WHERE l.company_id = ?
          UNION
          SELECT m2.id FROM meetings m2
          JOIN contacts c ON c.primary_company_id = ?
          WHERE c.email IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM json_each(COALESCE(m2.attendee_emails, '[]')) e
              WHERE lower(trim(e.value)) = lower(trim(c.email))
            )
        )
      ORDER BY datetime(m.date) DESC
    `)
    .all(companyId, companyId) as Array<{ id: string; title: string; date: string; summary_path: string }>

  return rows.map((row) => ({
    meetingId: row.id,
    title: row.title,
    date: row.date,
    summaryPath: row.summary_path
  }))
}

export function listMeetingCompanies(meetingId: string): CompanySummary[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `${baseCompanySelect('WHERE c.id IN (SELECT company_id FROM meeting_company_links WHERE meeting_id = ?)')}
       ORDER BY datetime(c.updated_at) DESC, c.canonical_name ASC`
    )
    .all(meetingId) as CompanyRow[]

  return rows.map(rowToCompanySummary)
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
        c.contact_type,
        c.linkedin_url,
        c.key_takeaways,
        c.updated_at,
        COALESCE(occ.is_primary, 0) AS is_primary,
        COALESCE(ms.meeting_count, 0) AS meeting_count,
        ms.last_meeting_at
      FROM contacts c
      LEFT JOIN org_company_contacts occ ON occ.contact_id = c.id AND occ.company_id = ?
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
        OR occ.company_id IS NOT NULL
      ORDER BY is_primary DESC, datetime(COALESCE(ms.last_meeting_at, c.updated_at)) DESC, c.full_name ASC
      LIMIT 300
    `)
    .all(companyId, companyId) as Array<{
    id: string
    full_name: string
    email: string | null
    title: string | null
    contact_type: string | null
    linkedin_url: string | null
    key_takeaways: string | null
    updated_at: string
    is_primary: number
    meeting_count: number
    last_meeting_at: string | null
  }>

  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    title: row.title,
    contactType: row.contact_type,
    linkedinUrl: row.linkedin_url,
    keyTakeaways: row.key_takeaways,
    isPrimary: row.is_primary === 1,
    meetingCount: row.meeting_count || 0,
    lastInteractedAt: row.last_meeting_at ?? row.updated_at,
    updatedAt: row.updated_at
  }))
}

export function unlinkMeetingCompany(meetingId: string, companyId: string): void {
  const db = getDatabase()
  db.prepare(`
    DELETE FROM meeting_company_links
    WHERE meeting_id = ? AND company_id = ?
  `).run(meetingId, companyId)
}

export function clearCompanyPrimaryContact(companyId: string): void {
  const db = getDatabase()
  db.prepare(`
    UPDATE org_company_contacts
    SET is_primary = 0
    WHERE company_id = ?
  `).run(companyId)
}

export function setCompanyPrimaryContact(companyId: string, contactId: string): void {
  const db = getDatabase()
  db.transaction(() => {
    // Clear any existing primary contact for this company
    db.prepare(`
      UPDATE org_company_contacts
      SET is_primary = 0
      WHERE company_id = ?
    `).run(companyId)

    // Ensure the contact has a link row, then mark it primary
    db.prepare(`
      INSERT INTO org_company_contacts (company_id, contact_id, is_primary, created_at)
      VALUES (?, ?, 1, datetime('now'))
      ON CONFLICT(company_id, contact_id) DO UPDATE SET is_primary = 1
    `).run(companyId, contactId)
  })()
}

export function linkContactToCompany(companyId: string, contactId: string): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO org_company_contacts (company_id, contact_id, is_primary, created_at)
    VALUES (?, ?, 0, datetime('now'))
    ON CONFLICT(company_id, contact_id) DO NOTHING
  `).run(companyId, contactId)
}

export function unlinkContactFromCompany(companyId: string, contactId: string): void {
  const db = getDatabase()
  db.prepare(`
    DELETE FROM org_company_contacts WHERE company_id = ? AND contact_id = ?
  `).run(companyId, contactId)
  // If this was the contact's primary company, clear it
  db.prepare(`
    UPDATE contacts SET primary_company_id = NULL, updated_at = datetime('now')
    WHERE id = ? AND primary_company_id = ?
  `).run(contactId, companyId)
}

export function listCompanyEmails(companyId: string): CompanyEmailRef[] {
  const db = getDatabase()
  const rows = db
    .prepare(`
      WITH company_contact_ids AS (
        SELECT c.id
        FROM contacts c
        LEFT JOIN org_company_contacts occ ON occ.contact_id = c.id
        WHERE occ.company_id = ? OR c.primary_company_id = ?
      ),
      linked AS (
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
          COALESCE(em.thread_id, em.id) AS thread_group,
          em.account_id
        FROM email_company_links l
        JOIN email_messages em ON em.id = l.message_id
        WHERE l.company_id = ?
        UNION
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
          COALESCE(em.thread_id, em.id) AS thread_group,
          em.account_id
        FROM email_message_participants p
        JOIN email_messages em ON em.id = p.message_id
        WHERE p.contact_id IN (SELECT id FROM company_contact_ids)
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
          COUNT(*) OVER (PARTITION BY thread_group) AS thread_message_count,
          account_id
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
        COALESCE(ranked.thread_id, ranked.id) AS thread_group,
        ranked.thread_message_count,
        COALESCE(participants.participants_json, '[]') AS participants_json,
        ea.account_email
      FROM ranked
      LEFT JOIN participants ON participants.message_id = ranked.id
      LEFT JOIN email_accounts ea ON ea.id = ranked.account_id
      WHERE ranked.row_num = 1
      ORDER BY datetime(ranked.sort_at) DESC, ranked.id DESC
      LIMIT 200
    `)
    .all(companyId, companyId, companyId) as EmailMessageRow[]

  return rows.map(mapEmailRow)
}

export function getCompanyEmailById(messageId: string): CompanyEmailRef | null {
  const db = getDatabase()
  const row = db
    .prepare(`
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
        et.provider_thread_id,
        ea.account_email,
        1 AS thread_message_count,
        COALESCE((
          SELECT json_group_array(
            json_object(
              'role', p2.role,
              'email', LOWER(p2.email),
              'displayName', COALESCE(NULLIF(TRIM(p2.display_name), ''), NULLIF(TRIM(c2.full_name), '')),
              'contactId', p2.contact_id
            )
          )
          FROM (
            SELECT p.role, p.email, p.display_name, p.contact_id
            FROM email_message_participants p
            WHERE p.message_id = em.id
            ORDER BY
              CASE p.role WHEN 'from' THEN 0 WHEN 'to' THEN 1 WHEN 'cc' THEN 2
                          WHEN 'bcc' THEN 3 WHEN 'reply_to' THEN 4 ELSE 5 END,
              p.email
          ) p2
          LEFT JOIN contacts c2 ON c2.id = p2.contact_id
        ), '[]') AS participants_json
      FROM email_messages em
      LEFT JOIN email_threads et ON et.id = em.thread_id
      LEFT JOIN email_accounts ea ON ea.id = em.account_id
      WHERE em.id = ?
    `)
    .get(messageId) as EmailMessageRow | undefined
  return row ? mapEmailRow(row) : null
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
    referenceType: 'email',
    threadGroup: email.threadGroup
  }))

  const noteRows = db
    .prepare(`
      SELECT id, title, content, created_at, updated_at
      FROM notes
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

  const decisionRows = db
    .prepare(`
      SELECT id, decision_type, decision_date, decision_owner, rationale_json
      FROM company_decision_logs
      WHERE company_id = ?
      ORDER BY decision_date DESC
      LIMIT 100
    `)
    .all(companyId) as Array<{
    id: string
    decision_type: string
    decision_date: string
    decision_owner: string | null
    rationale_json: string | null
  }>
  const decisionItems: CompanyTimelineItem[] = decisionRows.map((d) => {
    let title = d.decision_type
    if (d.decision_type === 'Stage Change' || d.decision_type === 'Pipeline Exit') {
      try {
        const rationaleArr: string[] = d.rationale_json ? JSON.parse(d.rationale_json) : []
        const msg = rationaleArr[0] ?? ''
        const stageMatch = msg.match(/^Moved from (.+) to (.+)$/)
        if (stageMatch) {
          title = `${stageMatch[1]} → ${stageMatch[2]}`
        } else {
          const exitMatch = msg.match(/^Removed from pipeline \(was: (.+)\)$/)
          if (exitMatch) {
            title = `${exitMatch[1]} → Exited`
          }
        }
      } catch {
        // fall back to decision_type
      }
    }
    return {
      id: `decision:${d.id}`,
      type: 'decision',
      title,
      // Append T12:00:00Z to date-only strings to avoid midnight UTC timezone drift
      occurredAt: d.decision_date.includes('T') ? d.decision_date : `${d.decision_date}T12:00:00Z`,
      subtitle: d.decision_owner ?? null,
      referenceId: d.id,
      referenceType: 'company_decision_log'
    }
  })

  return [...meetingItems, ...emailItems, ...noteItems, ...decisionItems].sort((a, b) =>
    new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  )
}

export function deleteCompanyEmailLinks(companyId: string, threadGroups: string[]): { deleted: number } {
  if (threadGroups.length === 0) return { deleted: 0 }
  const db = getDatabase()
  const placeholders = threadGroups.map(() => '?').join(',')
  const result = db
    .prepare(`
      DELETE FROM email_company_links
      WHERE company_id = ?
        AND message_id IN (
          SELECT id FROM email_messages
          WHERE COALESCE(thread_id, id) IN (${placeholders})
        )
    `)
    .run(companyId, ...threadGroups)
  return { deleted: result.changes }
}

// Known company suffix patterns for the regex fallback in fixConcatenatedCompanyNames.
// Matches names like "bowleycapital" → "Bowley Capital" where the prefix is not in DOMAIN_WORDS.
const CONCAT_SUFFIX_PATTERN =
  /^(.+?)(corp|inc|llc|ltd|lp|ventures?|capital|partners?|labs?|tech|health|group|solutions|services|systems|holdings?)$/i

export interface CompanyNameFixResult {
  id: string
  before: string
  after: string
  action: 'renamed' | 'merged'
}

/**
 * One-time (idempotent) pass over all companies whose canonical_name has no spaces.
 * Attempts to detect and fix concatenated multi-word names using three strategies
 * in order (first match wins):
 *
 *   1. CamelCase split:   "AcmeCorp"        → "Acme Corp"        (high confidence)
 *   2. DOMAIN_WORDS:      "redswanventures" → "Red Swan Ventures" (medium confidence)
 *   3. Suffix regex:      "bowleycapital"   → "Bowley Capital"    (lower confidence)
 *
 * On conflict (suggested name already exists as a different company):
 *   → mergeCompanies(existingId, currentId)  (folds duplicate into canonical)
 * On no conflict:
 *   → updateCompany(currentId, { canonicalName: suggested })
 *
 * Safe to run multiple times — already-fixed names have spaces and are skipped.
 */
export function fixConcatenatedCompanyNames(
  userId: string | null
): { fixed: number; merged: number; changes: CompanyNameFixResult[] } {
  const db = getDatabase()
  const changes: CompanyNameFixResult[] = []
  let fixed = 0
  let merged = 0

  const rows = db
    .prepare(
      `SELECT id, canonical_name FROM org_companies WHERE canonical_name NOT LIKE '% %'`
    )
    .all() as Array<{ id: string; canonical_name: string }>

  db.transaction(() => {
    for (const row of rows) {
      const name = row.canonical_name

      // Skip: too short, all-uppercase (abbreviations like IBM/IDEO), contains digits
      if (name.length <= 3) continue
      if (name.length > 60) continue     // cap for trySegment O(n²) safety
      if (!/[a-z]/.test(name)) continue  // all-caps → abbreviation, leave alone
      if (/\d/.test(name)) continue

      let suggested: string | null = null

      // Step 1: CamelCase split (high confidence — unambiguous word boundaries)
      const camel = splitCamelCase(name)
      if (camel !== name) {
        suggested = camel
      }

      // Step 2: DOMAIN_WORDS segmentation via trySegment
      if (!suggested) {
        const segments = trySegment(name.toLowerCase(), 0)
        if (segments && segments.length > 1) {
          suggested = segments.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
        }
      }

      // Step 3: Suffix-only regex fallback (catches proper-name prefix + known suffix)
      if (!suggested) {
        const m = name.toLowerCase().match(CONCAT_SUFFIX_PATTERN)
        if (m && m[1].length >= 3) {
          const prefix = m[1][0].toUpperCase() + m[1].slice(1)
          const suffix = m[2][0].toUpperCase() + m[2].slice(1)
          suggested = `${prefix} ${suffix}`
        }
      }

      if (!suggested) continue

      // Conflict check: does the suggested name already exist as a different company?
      const existingId = findCompanyIdByNameOrDomain(suggested, null)

      if (existingId && existingId !== row.id) {
        // Fold the concatenated entry into the existing canonical record
        mergeCompanies(existingId, row.id)
        logAudit(userId, 'company', row.id, 'update', { before: name, after: suggested, action: 'merged' })
        changes.push({ id: row.id, before: name, after: suggested, action: 'merged' })
        merged++
      } else {
        updateCompany(row.id, { canonicalName: suggested }, userId)
        logAudit(userId, 'company', row.id, 'update', { before: name, after: suggested, action: 'renamed' })
        changes.push({ id: row.id, before: name, after: suggested, action: 'renamed' })
        fixed++
      }
    }
  })()

  return { fixed, merged, changes }
}
