import type {
  ContactSortBy,
  ContactSummary,
  ContactType
} from '../../../shared/types/contact'
import {
  createColumnConfigLoader,
  saveColumnConfig as saveColumnConfigBase,
  sortRows as sortRowsBase,
  type ColumnDef,
  type SortState
} from '../crm/tableUtils'

// Re-export shared types
export type { ColumnDef, SortState }

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
    editable: false,  // click navigates to company
    type: 'computed'
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

export function loadContactColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WIDTHS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, number>
  } catch {
    return {}
  }
}

export function saveContactColumnWidths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths))
  } catch {
    console.warn('[ContactTable] Failed to save column widths')
  }
}

// ─── Sort (delegate to tableUtils) ────────────────────────────────────────────

export function sortContacts(
  contacts: ContactSummary[],
  sort: SortState,
  defs: ColumnDef[]
): ContactSummary[] {
  return sortRowsBase(contacts as Record<string, unknown>[], sort, defs) as ContactSummary[]
}

// ─── Filter ───────────────────────────────────────────────────────────────────

export function filterContacts(
  contacts: ContactSummary[],
  typeFilter: ContactType[]
): ContactSummary[] {
  if (typeFilter.length === 0) return contacts
  return contacts.filter(
    (c) => c.contactType != null && typeFilter.includes(c.contactType)
  )
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
