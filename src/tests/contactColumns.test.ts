// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  filterContacts,
  CONTACT_COLUMN_DEFS,
  CONTACT_DEFAULT_VISIBLE_KEYS
} from '../renderer/components/contact/contactColumns'
import { sortRows } from '../renderer/components/crm/tableUtils'
import type { SortState } from '../renderer/components/crm/tableUtils'
import type { ContactSummary } from '../shared/types/contact'

const sortContacts = (contacts: ContactSummary[], sort: SortState, defs: typeof CONTACT_COLUMN_DEFS) =>
  sortRows(contacts as Record<string, unknown>[], sort, defs) as ContactSummary[]

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeContact(overrides: Partial<ContactSummary>): ContactSummary {
  return {
    id: crypto.randomUUID(),
    fullName: 'Test User',
    firstName: 'Test',
    lastName: 'User',
    normalizedName: 'test user',
    email: null,
    title: null,
    contactType: null,
    primaryCompanyId: null,
    primaryCompanyName: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    talentPipeline: null,
    lastTouchpoint: null,
    meetingCount: 0,
    emailCount: 0,
    createdAt: '2024-01-01 00:00:00',
    updatedAt: '2024-01-01 00:00:00',
    phone: null,
    street: null,
    city: null,
    state: null,
    postalCode: null,
    country: null,
    timezone: null,
    twitterHandle: null,
    university: null,
    pronouns: null,
    lastMetEvent: null,
    warmIntroPath: null,
    notes: null,
    fundSize: null,
    typicalCheckSizeMin: null,
    typicalCheckSizeMax: null,
    investmentSectorFocusNotes: null,
    proudPortfolioCompanies: null,
    tags: null,
    previousCompanies: null,
    investmentStageFocus: null,
    investmentSectorFocus: null,
    ...overrides
  }
}

// ─── filterContacts ───────────────────────────────────────────────────────────

describe('filterContacts', () => {
  const contacts = [
    makeContact({ id: '1', contactType: 'investor' }),
    makeContact({ id: '2', contactType: 'founder' }),
    makeContact({ id: '3', contactType: 'operator' }),
    makeContact({ id: '4', contactType: null })
  ]

  it('returns all contacts when typeFilter is empty', () => {
    expect(filterContacts(contacts, { columnFilters: {} })).toHaveLength(4)
  })

  it('filters to a single type', () => {
    const result = filterContacts(contacts, { columnFilters: { contactType: ['investor'] } })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('1')
  })

  it('filters to multiple types', () => {
    const result = filterContacts(contacts, { columnFilters: { contactType: ['investor', 'founder'] } })
    expect(result).toHaveLength(2)
    expect(result.map((c) => c.id)).toEqual(['1', '2'])
  })

  it('excludes contacts with null contactType even when filter is non-empty', () => {
    const result = filterContacts(contacts, { columnFilters: { contactType: ['investor', 'founder', 'operator'] } })
    expect(result).toHaveLength(3)
    expect(result.map((c) => c.id)).not.toContain('4')
  })
})

// ─── sortContacts ─────────────────────────────────────────────────────────────

describe('sortContacts', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  const contacts = [
    makeContact({ id: '1', fullName: 'Zara Smith',  meetingCount: 5 }),
    makeContact({ id: '2', fullName: 'Alice Brown', meetingCount: 2 }),
    makeContact({ id: '3', fullName: 'Bob Jones',   meetingCount: 10 })
  ]

  it('sorts by fullName ascending', () => {
    const sort: SortState = [{ key: 'name', dir: 'asc' }]
    const result = sortContacts(contacts, sort, CONTACT_COLUMN_DEFS)
    expect(result.map((c) => c.id)).toEqual(['2', '3', '1'])
  })

  it('sorts by fullName descending', () => {
    const sort: SortState = [{ key: 'name', dir: 'desc' }]
    const result = sortContacts(contacts, sort, CONTACT_COLUMN_DEFS)
    expect(result.map((c) => c.id)).toEqual(['1', '3', '2'])
  })

  it('sorts by meetingCount ascending', () => {
    const sort: SortState = [{ key: 'meetingCount', dir: 'asc' }]
    const result = sortContacts(contacts, sort, CONTACT_COLUMN_DEFS)
    expect(result.map((c) => c.id)).toEqual(['2', '1', '3'])
  })
})

describe('CONTACT_COLUMN_DEFS — extended fields surfaced in the picker', () => {
  const byKey = (k: string) => CONTACT_COLUMN_DEFS.find((c) => c.key === k)

  it('includes the address/location columns', () => {
    for (const k of ['city', 'state', 'location', 'phone', 'country']) {
      expect(byKey(k), `missing column: ${k}`).toBeDefined()
    }
  })

  it('exposes the multi-value JSON fields as read-only computed columns', () => {
    for (const k of ['tags', 'previousCompanies', 'investmentStageFocus', 'investmentSectorFocus']) {
      const def = byKey(k)
      expect(def, `missing column: ${k}`).toBeDefined()
      expect(def!.type).toBe('computed')
      expect(def!.editable).toBe(false)
      expect(def!.field).toBeNull()
    }
  })

  it('keeps all new columns hidden by default (default-visible set unchanged)', () => {
    // No new key is default-visible; the default set is the original 7.
    expect(CONTACT_DEFAULT_VISIBLE_KEYS).not.toContain('city')
    expect(CONTACT_DEFAULT_VISIBLE_KEYS).not.toContain('location')
    expect(CONTACT_DEFAULT_VISIBLE_KEYS).not.toContain('tags')
  })
})
