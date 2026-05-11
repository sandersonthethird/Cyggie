import type {
  CompanyEntityType,
  CompanyListFilter,
  CompanyPriority,
  CompanyRound,
  CompanySummary,
  CompanySortBy
} from '../../../shared/types/company'
import { ENTITY_TYPE_OPTIONS, PORTFOLIO_FUND_OPTIONS, INVESTMENT_SECURITY_OPTIONS, STATUS_OPTIONS } from '../../../shared/types/company'
import { CANONICAL_INDUSTRIES } from '../../../shared/constants/industries'
import { COMPANY_STAGE_OPTIONS } from '../common/PipelineStepper'
import {
  createColumnConfigLoader,
  saveColumnConfig as saveColumnConfigBase,
  createColumnWidthsHelper,
  applySelectFilter,
  applyRangeFilter,
  applyTextFilter,
  applyCustomSelectFilter,
  applyCustomRangeFilter,
  applyCustomTextFilter,
  splitFiltersByCustom,
  type ColumnDef,
  type RangeValue,
  type SortKey,
  type SortState,
  type CustomFieldValuesMap,
  type CustomFieldTypesMap
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

export const STAGES = COMPANY_STAGE_OPTIONS

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

export const INDUSTRY_OPTIONS: { value: string; label: string }[] = CANONICAL_INDUSTRIES.map((v) => ({ value: v, label: v }))

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
    key: 'industry',
    label: 'Industry',
    field: 'industry',
    defaultVisible: false,
    width: 160,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: INDUSTRY_OPTIONS,
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
    width: 200,
    minWidth: 120,
    sortable: true,
    editable: true,
    type: 'investor_chips',
    maxChips: 1
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
    label: 'Total Investment',
    field: 'totalInvested',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text',
    prefix: '$',
    decimals: 2
  },
  {
    key: 'investmentMark',
    label: 'Investment Mark',
    field: 'investmentMark',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    decimals: 2
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
    label: 'Initial Investment',
    field: 'investmentSize',
    defaultVisible: false,
    width: 170,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text',
    prefix: '$',
    decimals: 2
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
    key: 'status',
    label: 'Status',
    field: 'status',
    defaultVisible: false,
    width: 110,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: STATUS_OPTIONS
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
    suffix: '%',
    sigDigits: 2
  },
  {
    key: 'initialRoundSize',
    label: 'Initial Round Size',
    field: 'initialRoundSize',
    defaultVisible: false,
    width: 170,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    decimals: 2
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
    label: 'Follow-on Check',
    field: 'followonCheck',
    defaultVisible: false,
    width: 160,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    decimals: 2
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
    label: 'Follow-on Check 2',
    field: 'followonCheck2',
    defaultVisible: false,
    width: 170,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number',
    prefix: '$',
    decimals: 2
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
    width: 280,
    minWidth: 120,
    sortable: true,
    editable: true,
    type: 'investor_chips'
  },
  {
    key: 'priorInvestorNames',
    label: 'Prior Investors',
    field: 'priorInvestorNames',
    defaultVisible: false,
    width: 280,
    minWidth: 120,
    sortable: true,
    editable: true,
    type: 'investor_chips'
  },
  {
    key: 'subsequentInvestorNames',
    label: 'Subsequent Investors',
    field: 'subsequentInvestorNames',
    defaultVisible: false,
    width: 280,
    minWidth: 120,
    sortable: true,
    editable: true,
    type: 'investor_chips'
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

export interface FilterCompaniesOptions {
  /** Select filter values per field, from useTableFilters.columnFilters. May contain 'custom:' keys. */
  columnFilters: Record<string, string[]>
  /** Range bounds per field. May contain 'custom:' keys. */
  rangeFilters?: Record<string, RangeValue>
  /** Text queries per field. May contain 'custom:' keys. */
  textFilters?: Record<string, string>
  /** Bulk custom field values keyed by [entityId][defId]. From useCustomFieldValues. */
  customFieldValues?: CustomFieldValuesMap
  /** Field type per defId, used to dispatch numeric vs. date range comparison. */
  customFieldTypes?: CustomFieldTypesMap
}

/**
 * Client-side filter for CompanySummary[].
 *
 * Six-pass chain (all filters AND together):
 *   Pass 1: Built-in select  — exact match on row[field]            (applySelectFilter)
 *   Pass 2: Built-in range   — numeric or date inclusive bounds      (applyRangeFilter)
 *   Pass 3: Built-in text    — case-insensitive contains             (applyTextFilter)
 *   Pass 4: Custom select    — comma-split + intersection            (applyCustomSelectFilter)
 *   Pass 5: Custom range     — number/date dispatch via field types  (applyCustomRangeFilter)
 *   Pass 6: Custom text      — case-insensitive contains on customs  (applyCustomTextFilter)
 *
 * Custom filter dicts use 'custom:<defId>' keys; splitFiltersByCustom partitions
 * them and strips the prefix so downstream passes can look up values/types by defId.
 */
export function filterCompanies(
  companies: CompanySummary[],
  opts: FilterCompaniesOptions
): CompanySummary[] {
  const { columnFilters, rangeFilters, textFilters, customFieldValues = {}, customFieldTypes = {} } = opts

  const select = splitFiltersByCustom(columnFilters)
  const range = splitFiltersByCustom(rangeFilters ?? {})
  const text = splitFiltersByCustom(textFilters ?? {})

  let result = applySelectFilter(companies as unknown as Record<string, unknown>[], select.builtIn) as unknown as CompanySummary[]
  result = applyRangeFilter(result as unknown as Record<string, unknown>[], range.builtIn) as unknown as CompanySummary[]
  result = applyTextFilter(result as unknown as Record<string, unknown>[], text.builtIn) as unknown as CompanySummary[]
  result = applyCustomSelectFilter(result, select.custom, customFieldValues)
  result = applyCustomRangeFilter(result, range.custom, customFieldValues, customFieldTypes)
  result = applyCustomTextFilter(result, text.custom, customFieldValues)
  return result
}

// ─── URL → IPC filter builder ─────────────────────────────────────────────────

export function buildUrlFilter(
  query: string,
  sortBy: CompanySortBy,
  opts?: { includeInvestorNames?: boolean }
): CompanyListFilter {
  // No limit — view: 'all' means all companies. baseCompanySelect uses LEFT JOINs
  // (not correlated subqueries) so this is O(n) and fast in SQLite at current scale.
  // See TODOS.md "Companies table: server-side pagination" for the long-term fix.
  return {
    query: query.trim() || undefined,
    view: 'all',
    includeStats: true,
    sortBy,
    includeInvestorNames: opts?.includeInvestorNames,
  }
}
