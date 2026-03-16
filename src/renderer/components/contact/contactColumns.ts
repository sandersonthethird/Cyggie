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
  type ColumnDef,
  type RangeValue,
  type SortState
} from '../crm/tableUtils'

// Re-export shared types
export type { ColumnDef, RangeValue, SortState }

// ─── Option arrays ────────────────────────────────────────────────────────────

export const CONTACT_TYPES: { value: ContactType; label: string }[] = [
  { value: 'investor', label: 'Investor' },
  { value: 'founder', label: 'Founder' },
  { value: 'operator', label: 'Operator' }
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

/**
 * Client-side filter for ContactSummary[].
 *
 * Three-pass chain (all filters AND together):
 *   Pass 1: Select filters — exact match against option values
 *   Pass 2: Range filters — numeric or date inclusive bounds (applyRangeFilter from tableUtils)
 *   Pass 3: Text filters  — case-insensitive contains (applyTextFilter from tableUtils)
 *
 * Forward-compatible: adding new filterable columns to CONTACT_COLUMN_DEFS requires no changes here.
 */
export function filterContacts(
  contacts: ContactSummary[],
  filters: Record<string, string[]>,
  rangeFilters?: Record<string, RangeValue>,
  textFilters?: Record<string, string>
): ContactSummary[] {
  // Three-pass chain (all filters AND together):
  //   Pass 1: Select filters  — exact match against option values (applySelectFilter)
  //   Pass 2: Range filters   — numeric or date inclusive bounds (applyRangeFilter)
  //   Pass 3: Text filters    — case-insensitive contains (applyTextFilter)
  let result = applySelectFilter(contacts as Record<string, unknown>[], filters) as ContactSummary[]
  result = applyRangeFilter(result as Record<string, unknown>[], rangeFilters ?? {}) as ContactSummary[]
  result = applyTextFilter(result as Record<string, unknown>[], textFilters ?? {}) as ContactSummary[]
  return result
}

// ─── URL → IPC filter builder ─────────────────────────────────────────────────

export interface ContactListFilter {
  query?: string
  limit?: number
  sortBy?: ContactSortBy
}

export type ContactScope = 'all'

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
