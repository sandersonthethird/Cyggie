import type {
  CompanyEntityType,
  CompanyListFilter,
  CompanyPipelineStage,
  CompanyPriority,
  CompanyRound,
  CompanySummary,
  CompanySortBy
} from '../../../shared/types/company'
import { ENTITY_TYPE_OPTIONS, PORTFOLIO_FUND_OPTIONS, INVESTMENT_SECURITY_OPTIONS } from '../../../shared/types/company'
import {
  createColumnConfigLoader,
  saveColumnConfig as saveColumnConfigBase,
  createColumnWidthsHelper,
  applySelectFilter,
  applyRangeFilter,
  applyTextFilter,
  type ColumnDef,
  type RangeValue,
  type SortKey,
  type SortState
} from '../crm/tableUtils'

// Re-export shared types so existing imports keep working
export type { ColumnDef, RangeValue, SortKey, SortState }

// ─── Groupable field definition ───────────────────────────────────────────────

export interface GroupableField {
  key: string
  label: string
  /** Ordered list of values — groups appear in this order; null/"No value" always last. */
  order: string[]
}

// ─── Option arrays ────────────────────────────────────────────────────────────

export const ENTITY_TYPES = ENTITY_TYPE_OPTIONS

export const STAGES: { value: CompanyPipelineStage; label: string }[] = [
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Decision' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass', label: 'Pass' }
]

export const PRIORITIES: { value: CompanyPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'further_work', label: 'Further Work' },
  { value: 'monitor', label: 'Monitor' }
]

export const ROUNDS: { value: CompanyRound; label: string }[] = [
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' }
]

export const PORTFOLIOS = PORTFOLIO_FUND_OPTIONS

export const EMPLOYEE_RANGES = [
  '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'
]

export const TARGET_CUSTOMERS: { value: string; label: string }[] = [
  { value: 'b2b', label: 'B2B' },
  { value: 'b2c', label: 'B2C' },
  { value: 'b2b2c', label: 'B2B2C' },
  { value: 'government', label: 'Government' },
  { value: 'other', label: 'Other' },
]

export const BUSINESS_MODELS: { value: string; label: string }[] = [
  { value: 'saas', label: 'SaaS' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'transactional', label: 'Transactional' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'services', label: 'Services' },
  { value: 'other', label: 'Other' },
]

export const PRODUCT_STAGES: { value: string; label: string }[] = [
  { value: 'pre_product', label: 'Pre-product' },
  { value: 'mvp', label: 'MVP' },
  { value: 'beta', label: 'Beta' },
  { value: 'ga', label: 'GA' },
  { value: 'scaling', label: 'Scaling' },
]

// Keys that are hardcoded in the company header — excluded from the pin mechanism
export const COMPANY_HEADER_KEYS = new Set(['entityType', 'pipelineStage', 'priority', 'round'])

// ─── Column definitions ───────────────────────────────────────────────────────

export const COLUMN_DEFS: ColumnDef[] = [
  {
    key: 'name',
    label: 'Company',
    field: 'canonicalName',
    defaultVisible: true,
    width: 240,
    minWidth: 120,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  {
    key: 'primaryDomain',
    label: 'Domain',
    field: 'primaryDomain',
    defaultVisible: true,
    width: 160,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'entityType',
    label: 'Type',
    field: 'entityType',
    defaultVisible: true,
    width: 110,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: ENTITY_TYPES
  },
  {
    key: 'pipelineStage',
    label: 'Process',
    field: 'pipelineStage',
    defaultVisible: true,
    width: 120,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...STAGES]
  },
  {
    key: 'priority',
    label: 'Priority',
    field: 'priority',
    defaultVisible: true,
    width: 110,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...PRIORITIES]
  },
  {
    key: 'lastTouchpoint',
    label: 'Last Touch',
    field: 'lastTouchpoint',
    defaultVisible: true,
    width: 120,
    minWidth: 80,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  {
    key: 'contactCount',
    label: 'Contacts',
    field: 'contactCount',
    defaultVisible: true,
    width: 80,
    minWidth: 60,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  // Hidden by default
  {
    key: 'round',
    label: 'Last Round',
    field: 'round',
    defaultVisible: false,
    width: 110,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...ROUNDS]
  },
  {
    key: 'portfolioFund',
    label: 'Portfolio',
    field: 'portfolioFund',
    defaultVisible: false,
    width: 110,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...PORTFOLIOS]
  },
  {
    key: 'raiseSize',
    label: 'Raise ($M)',
    field: 'raiseSize',
    defaultVisible: false,
    width: 100,
    minWidth: 70,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'postMoneyValuation',
    label: 'Initial Valuation ($M)',
    field: 'postMoneyValuation',
    defaultVisible: false,
    width: 140,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'arr',
    label: 'ARR ($M)',
    field: 'arr',
    defaultVisible: false,
    width: 100,
    minWidth: 70,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'sector',
    label: 'Sector',
    field: 'sector',
    defaultVisible: false,
    width: 140,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'city',
    label: 'City',
    field: 'city',
    defaultVisible: false,
    width: 120,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'foundingYear',
    label: 'Founded',
    field: 'foundingYear',
    defaultVisible: false,
    width: 80,
    minWidth: 60,
    sortable: true,
    editable: true,
    type: 'number'
  },
  {
    key: 'employeeCountRange',
    label: 'Employees',
    field: 'employeeCountRange',
    defaultVisible: false,
    width: 100,
    minWidth: 80,
    sortable: false,
    editable: true,
    type: 'text'
  },
  {
    key: 'leadInvestor',
    label: 'Lead Investor',
    field: 'leadInvestor',
    defaultVisible: false,
    width: 140,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'relationshipOwner',
    label: 'Owner',
    field: 'relationshipOwner',
    defaultVisible: false,
    width: 120,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'nextFollowupDate',
    label: 'Next Follow-up',
    field: 'nextFollowupDate',
    defaultVisible: false,
    width: 130,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'date'
  },
  {
    key: 'createdAt',
    label: 'Date Added',
    field: 'createdAt',
    defaultVisible: false,
    width: 110,
    minWidth: 90,
    sortable: true,
    editable: false,
    type: 'date'
  },
  // ── Fund IV / portfolio investment columns ──────────────────────────────────
  {
    key: 'description',
    label: 'Description',
    field: 'description',
    defaultVisible: false,
    width: 300,
    minWidth: 120,
    sortable: false,
    editable: true,
    type: 'text'
  },
  {
    key: 'industriesCsv',
    label: 'Industry',
    field: 'industriesCsv',
    defaultVisible: false,
    width: 160,
    minWidth: 80,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  {
    key: 'location',
    label: 'Location',
    field: null,
    defaultVisible: false,
    width: 160,
    minWidth: 80,
    sortable: false,
    editable: false,
    type: 'computed'
  },
  {
    key: 'totalInvested',
    label: 'Total Investment ($M)',
    field: 'totalInvested',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'investmentMark',
    label: 'Investment Mark ($M)',
    field: 'investmentMark',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M',
    decimals: 3
  },
  {
    key: 'investmentRound',
    label: 'Investment Round',
    field: 'investmentRound',
    defaultVisible: false,
    width: 140,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...ROUNDS]
  },
  {
    key: 'investmentSize',
    label: 'Initial Investment ($M)',
    field: 'investmentSize',
    defaultVisible: false,
    width: 170,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'initialInvestmentSecurity',
    label: 'Initial Security',
    field: 'initialInvestmentSecurity',
    defaultVisible: false,
    width: 140,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...INVESTMENT_SECURITY_OPTIONS]
  },
  {
    key: 'dateOfInitialInvestment',
    label: 'Date of Initial Investment',
    field: 'dateOfInitialInvestment',
    defaultVisible: false,
    width: 170,
    minWidth: 120,
    sortable: true,
    editable: true,
    type: 'date'
  },
  {
    key: 'ownershipPct',
    label: 'Initial Ownership (%)',
    field: 'ownershipPct',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text',
    suffix: '%'
  },
  {
    key: 'initialRoundSize',
    label: 'Initial Round Size ($M)',
    field: 'initialRoundSize',
    defaultVisible: false,
    width: 170,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M',
    decimals: 1
  },
  {
    key: 'lastCompanyValuation',
    label: 'Last Company Valuation ($M)',
    field: 'lastCompanyValuation',
    defaultVisible: false,
    width: 200,
    minWidth: 120,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M',
    decimals: 1
  },
  {
    key: 'followonCheck',
    label: 'Follow-on Check ($M)',
    field: 'followonCheck',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'followonDate',
    label: 'Follow-on Date',
    field: 'followonDate',
    defaultVisible: false,
    width: 130,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'date'
  },
  {
    key: 'followonCheck2',
    label: 'Follow-on Check 2 ($M)',
    field: 'followonCheck2',
    defaultVisible: false,
    width: 170,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    suffix: 'M'
  },
  {
    key: 'followonDate2',
    label: 'Follow-on Date 2',
    field: 'followonDate2',
    defaultVisible: false,
    width: 140,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'date'
  },
  {
    key: 'coInvestorNames',
    label: 'Coinvestors',
    field: 'coInvestorNames',
    defaultVisible: false,
    width: 200,
    minWidth: 100,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  {
    key: 'subsequentInvestorNames',
    label: 'Subsequent Investors',
    field: 'subsequentInvestorNames',
    defaultVisible: false,
    width: 200,
    minWidth: 100,
    sortable: true,
    editable: false,
    type: 'computed'
  }
]

export const DEFAULT_VISIBLE_KEYS = COLUMN_DEFS
  .filter((c) => c.defaultVisible)
  .map((c) => c.key)

// ─── Groupable fields ─────────────────────────────────────────────────────────

export const COMPANY_GROUPABLE_FIELDS: GroupableField[] = [
  { key: 'entityType',    label: 'Type',     order: ENTITY_TYPES.map((e) => e.value) },
  { key: 'pipelineStage', label: 'Stage',    order: STAGES.map((s) => s.value) },
  { key: 'priority',      label: 'Priority', order: PRIORITIES.map((p) => p.value) },
  { key: 'round',         label: 'Last Round', order: ROUNDS.map((r) => r.value) },
  { key: 'portfolioFund', label: 'Portfolio', order: PORTFOLIOS.map((p) => p.value) },
]

// ─── localStorage helpers (delegate to tableUtils) ────────────────────────────

const COLUMNS_KEY = 'cyggie:company-table-columns'
const WIDTHS_KEY = 'cyggie:company-table-widths'

export const loadColumnConfig = createColumnConfigLoader(COLUMNS_KEY, COLUMN_DEFS)

export function saveColumnConfig(visibleKeys: string[]): void {
  saveColumnConfigBase(COLUMNS_KEY, visibleKeys)
}

const widthsHelper = createColumnWidthsHelper(WIDTHS_KEY)
export const loadColumnWidths = widthsHelper.load
export const saveColumnWidths = widthsHelper.save

// ─── Filter ───────────────────────────────────────────────────────────────────

/**
 * Client-side filter for CompanySummary[].
 *
 * Three-pass chain (all filters AND together):
 *   Pass 1: Select filters — exact match against option values
 *   Pass 2: Range filters — numeric or date inclusive bounds (applyRangeFilter from tableUtils)
 *   Pass 3: Text filters  — case-insensitive contains (applyTextFilter from tableUtils)
 *
 * Forward-compatible: adding new filterable columns to COLUMN_DEFS requires no changes here.
 */
export function filterCompanies(
  companies: CompanySummary[],
  filters: Record<string, string[]>,
  rangeFilters?: Record<string, RangeValue>,
  textFilters?: Record<string, string>
): CompanySummary[] {
  // Three-pass chain (all filters AND together):
  //   Pass 1: Select filters  — exact match against option values (applySelectFilter)
  //   Pass 2: Range filters   — numeric or date inclusive bounds (applyRangeFilter)
  //   Pass 3: Text filters    — case-insensitive contains (applyTextFilter)
  let result = applySelectFilter(companies as unknown as Record<string, unknown>[], filters) as unknown as CompanySummary[]
  result = applyRangeFilter(result as unknown as Record<string, unknown>[], rangeFilters ?? {}) as unknown as CompanySummary[]
  result = applyTextFilter(result as unknown as Record<string, unknown>[], textFilters ?? {}) as unknown as CompanySummary[]
  return result
}

// ─── URL → IPC filter builder ─────────────────────────────────────────────────

export function buildUrlFilter(
  query: string,
  sortBy: CompanySortBy,
  opts?: { includeIndustries?: boolean; includeInvestorNames?: boolean }
): CompanyListFilter {
  // No limit — view: 'all' means all companies. baseCompanySelect uses LEFT JOINs
  // (not correlated subqueries) so this is O(n) and fast in SQLite at current scale.
  // See TODOS.md "Companies table: server-side pagination" for the long-term fix.
  return {
    query: query.trim() || undefined,
    view: 'all',
    includeStats: true,
    sortBy,
    includeIndustries: opts?.includeIndustries,
    includeInvestorNames: opts?.includeInvestorNames,
  }
}
