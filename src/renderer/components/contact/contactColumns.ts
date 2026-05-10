import type {
  ContactSortBy,
  ContactSummary
} from '../../../shared/types/contact'
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
import type { GroupableField } from '../company/companyColumns'

// Re-export shared types
export type { ColumnDef, GroupableField, RangeValue, SortKey, SortState }

// ─── Option arrays ────────────────────────────────────────────────────────────

export const CONTACT_TYPES: { value: ContactType; label: string }[] = [
  { value: 'investor', label: 'Investor' },
  { value: 'founder', label: 'Founder' },
  { value: 'operator', label: 'Operator' },
  { value: 'lp', label: 'LP' }
]

// Keys that are hardcoded in the contact header — excluded from the pin mechanism
export const CONTACT_HEADER_KEYS = new Set(['contactType'])

// ─── Column definitions ───────────────────────────────────────────────────────

export const CONTACT_COLUMN_DEFS: ColumnDef[] = [
  {
    key: 'name',
    label: 'Name',
    field: 'fullName',
    defaultVisible: true,
    width: 200,
    minWidth: 120,
    sortable: true,
    editable: false,  // click navigates
    type: 'computed'
  },
  {
    key: 'email',
    label: 'Email',
    field: 'email',
    defaultVisible: true,
    width: 200,
    minWidth: 100,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'title',
    label: 'Title',
    field: 'title',
    defaultVisible: true,
    width: 160,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'primaryCompanyName',
    label: 'Company',
    field: 'primaryCompanyName',
    defaultVisible: true,
    width: 160,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'contactType',
    label: 'Type',
    field: 'contactType',
    defaultVisible: true,
    width: 120,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'select',
    options: [{ value: '', label: '—' }, ...CONTACT_TYPES]
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
    key: 'meetingCount',
    label: 'Meetings',
    field: 'meetingCount',
    defaultVisible: true,
    width: 80,
    minWidth: 60,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  // Hidden by default
  {
    key: 'emailCount',
    label: 'Emails',
    field: 'emailCount',
    defaultVisible: false,
    width: 80,
    minWidth: 60,
    sortable: true,
    editable: false,
    type: 'computed'
  },
  {
    key: 'linkedinUrl',
    label: 'LinkedIn',
    field: 'linkedinUrl',
    defaultVisible: false,
    width: 140,
    minWidth: 80,
    sortable: false,
    editable: true,
    type: 'text'
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
  {
    key: 'firstName',
    label: 'First Name',
    field: 'firstName',
    defaultVisible: false,
    width: 130,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  },
  {
    key: 'lastName',
    label: 'Last Name',
    field: 'lastName',
    defaultVisible: false,
    width: 130,
    minWidth: 80,
    sortable: true,
    editable: true,
    type: 'text'
  }
]

export const CONTACT_DEFAULT_VISIBLE_KEYS = CONTACT_COLUMN_DEFS
  .filter((c) => c.defaultVisible)
  .map((c) => c.key)

// ─── Groupable fields ─────────────────────────────────────────────────────────

export const CONTACT_GROUPABLE_FIELDS: GroupableField[] = [
  { key: 'contactType', label: 'Type', order: CONTACT_TYPES.map((t) => t.value) },
]

// ─── localStorage helpers (delegate to tableUtils) ────────────────────────────

const COLUMNS_KEY = 'cyggie:contact-table-columns'
const WIDTHS_KEY = 'cyggie:contact-table-widths'

export const loadContactColumnConfig = createColumnConfigLoader(COLUMNS_KEY, CONTACT_COLUMN_DEFS)

export function saveContactColumnConfig(visibleKeys: string[]): void {
  saveColumnConfigBase(COLUMNS_KEY, visibleKeys)
}

const widthsHelper = createColumnWidthsHelper(WIDTHS_KEY)
export const loadContactColumnWidths = widthsHelper.load
export const saveContactColumnWidths = widthsHelper.save

// ─── Filter ───────────────────────────────────────────────────────────────────

export interface FilterContactsOptions {
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
 * Client-side filter for ContactSummary[].
 *
 * Six-pass chain (mirrors filterCompanies — see that doc for the full pipeline):
 *   built-in select / range / text + custom select / range / text.
 *
 * Custom filter dicts use 'custom:<defId>' keys; splitFiltersByCustom partitions
 * them and strips the prefix so downstream passes can look up values/types by defId.
 */
export function filterContacts(
  contacts: ContactSummary[],
  opts: FilterContactsOptions
): ContactSummary[] {
  const { columnFilters, rangeFilters, textFilters, customFieldValues = {}, customFieldTypes = {} } = opts

  const select = splitFiltersByCustom(columnFilters)
  const range = splitFiltersByCustom(rangeFilters ?? {})
  const text = splitFiltersByCustom(textFilters ?? {})

  let result = applySelectFilter(contacts as Record<string, unknown>[], select.builtIn) as ContactSummary[]
  result = applyRangeFilter(result as Record<string, unknown>[], range.builtIn) as ContactSummary[]
  result = applyTextFilter(result as Record<string, unknown>[], text.builtIn) as ContactSummary[]
  result = applyCustomSelectFilter(result, select.custom, customFieldValues)
  result = applyCustomRangeFilter(result, range.custom, customFieldValues, customFieldTypes)
  result = applyCustomTextFilter(result, text.custom, customFieldValues)
  return result
}

// ─── URL → IPC filter builder ─────────────────────────────────────────────────

export interface ContactListFilter {
  query?: string
  limit?: number
  sortBy?: ContactSortBy
}

export type ContactScope = 'all' | 'investors' | 'founders' | 'operators'

export const CONTACT_SCOPE_LABELS: Record<ContactScope, string> = {
  all: 'All', investors: 'Investors', founders: 'Founders', operators: 'Operators'
}

export const CONTACT_SCOPE_TO_TYPE: Record<ContactScope, string | null> = {
  all: null, investors: 'investor', founders: 'founder', operators: 'operator'
}

export function buildContactFilter(
  _scope: ContactScope,
  query: string,
  sortBy: ContactSortBy
): ContactListFilter {
  return {
    query: query.trim() || undefined,
    limit: 500,
    sortBy
  }
}
