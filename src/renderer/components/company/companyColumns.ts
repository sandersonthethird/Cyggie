import type {
  CompanyEntityType,
  CompanyListFilter,
  CompanyPipelineStage,
  CompanyPriority,
  CompanyRound,
  CompanySummary,
  CompanySortBy
} from '../../../shared/types/company'
import {
  createColumnConfigLoader,
  saveColumnConfig as saveColumnConfigBase,
  sortRows as sortRowsBase,
  type ColumnDef,
  type SortState
} from '../crm/tableUtils'

// Re-export shared types so existing imports keep working
export type { ColumnDef, SortState }

// ─── Option arrays ────────────────────────────────────────────────────────────

export const ENTITY_TYPES: { value: CompanyEntityType; label: string }[] = [
  { value: 'unknown', label: 'Unknown' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'pass', label: 'Pass' },
  { value: 'vc_fund', label: 'Investor' },
  { value: 'customer', label: 'Customer' },
  { value: 'partner', label: 'Partner' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'other', label: 'Other' }
]

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

export const EMPLOYEE_RANGES = [
  '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'
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
    label: 'Stage',
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
    label: 'Round',
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
    key: 'raiseSize',
    label: 'Raise ($M)',
    field: 'raiseSize',
    defaultVisible: false,
    width: 100,
    minWidth: 70,
    sortable: true,
    editable: true,
    type: 'number'
  },
  {
    key: 'postMoneyValuation',
    label: 'Post-Money ($M)',
    field: 'postMoneyValuation',
    defaultVisible: false,
    width: 140,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'number'
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
    type: 'number'
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
  }
]

export const DEFAULT_VISIBLE_KEYS = COLUMN_DEFS
  .filter((c) => c.defaultVisible)
  .map((c) => c.key)

// ─── localStorage helpers (delegate to tableUtils) ────────────────────────────

const COLUMNS_KEY = 'cyggie:company-table-columns'
const WIDTHS_KEY = 'cyggie:company-table-widths'

export const loadColumnConfig = createColumnConfigLoader(COLUMNS_KEY, COLUMN_DEFS)

export function saveColumnConfig(visibleKeys: string[]): void {
  saveColumnConfigBase(COLUMNS_KEY, visibleKeys)
}

export function loadColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, number>
  } catch {
    console.warn('[CompanyTable] Column widths parse failed, using defaults')
    return {}
  }
}

export function saveColumnWidths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
  } catch {
    console.warn('[CompanyTable] Failed to save column widths')
  }
}

// ─── Sort (delegate to tableUtils) ────────────────────────────────────────────

/** Client-side sort for CompanySummary[]. Nulls always sort last. */
export function sortRows(
  companies: CompanySummary[],
  sort: SortState,
  columnDefs: ColumnDef[]
): CompanySummary[] {
  return sortRowsBase(companies as Record<string, unknown>[], sort, columnDefs) as CompanySummary[]
}

// ─── Filter ───────────────────────────────────────────────────────────────────

export function filterCompanies(
  companies: CompanySummary[],
  typeFilter: CompanyEntityType[],
  stageFilter: CompanyPipelineStage[],
  priorityFilter: CompanyPriority[]
): CompanySummary[] {
  return companies.filter(
    (c) =>
      (typeFilter.length === 0 || typeFilter.includes(c.entityType)) &&
      (stageFilter.length === 0 ||
        (c.pipelineStage != null && stageFilter.includes(c.pipelineStage))) &&
      (priorityFilter.length === 0 ||
        (c.priority != null && priorityFilter.includes(c.priority)))
  )
}

// ─── URL → IPC filter builder ─────────────────────────────────────────────────

export type CompanyScope = 'all' | 'prospects' | 'vc_fund' | 'unknown'

export function buildUrlFilter(
  scope: CompanyScope,
  query: string,
  sortBy: CompanySortBy
): CompanyListFilter {
  const filter: CompanyListFilter = {
    query: query.trim() || undefined,
    limit: 400,
    view: 'all',
    includeStats: true,
    sortBy
  }

  if (scope === 'prospects') filter.entityTypes = ['prospect']
  else if (scope === 'vc_fund') filter.entityTypes = ['vc_fund']
  else if (scope === 'unknown') filter.entityTypes = ['unknown']

  return filter
}
