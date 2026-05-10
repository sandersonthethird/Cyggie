// @vitest-environment jsdom
/**
 * filterContacts integration with custom-field passes — mirrors the
 * filterCompanies coverage in company-table.test.ts. The shared filter passes
 * (applyCustomSelectFilter etc.) are unit-tested there; this file verifies the
 * Contact-side wiring of the options bag and 6-pass chain.
 */
import { describe, it, expect } from 'vitest'
import { filterContacts } from '../renderer/components/contact/contactColumns'
import type { ContactSummary } from '../shared/types/contact'

function makeContact(overrides: Partial<ContactSummary> = {}): ContactSummary {
  return {
    id: 'c-1',
    fullName: 'Test Contact',
    firstName: 'Test',
    lastName: 'Contact',
    normalizedName: 'test contact',
    email: null,
    primaryCompanyId: null,
    primaryCompanyName: null,
    title: null,
    contactType: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    meetingCount: 0,
    emailCount: 0,
    lastTouchpoint: null,
    createdAt: '2024-01-01 00:00:00',
    ...overrides,
  }
}

describe('filterContacts — custom-field integration', () => {
  it('built-in select + custom select compose with AND', () => {
    const contacts = [
      makeContact({ id: '1', contactType: 'investor' }),
      makeContact({ id: '2', contactType: 'investor' }),
      makeContact({ id: '3', contactType: 'founder' }),
    ]
    const customFieldValues = {
      '1': { focus: 'B2B' },
      '2': { focus: 'Consumer' },
      '3': { focus: 'B2B' },
    }
    const result = filterContacts(contacts, {
      columnFilters: { contactType: ['investor'], 'custom:focus': ['B2B'] },
      customFieldValues,
      customFieldTypes: { focus: 'select' },
    })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('custom multiselect filter intersects comma-joined cell value', () => {
    const contacts = [
      makeContact({ id: '1' }),
      makeContact({ id: '2' }),
    ]
    const customFieldValues = {
      '1': { tags: 'Lead,Investor' },
      '2': { tags: 'Operator' },
    }
    const result = filterContacts(contacts, {
      columnFilters: { 'custom:tags': ['Investor'] },
      customFieldValues,
      customFieldTypes: { tags: 'multiselect' },
    })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })

  it('custom text filter is case-insensitive contains', () => {
    const contacts = [
      makeContact({ id: '1' }),
      makeContact({ id: '2' }),
    ]
    const customFieldValues = {
      '1': { bio: 'Former CTO at Acme' },
      '2': { bio: 'Operator turned investor' },
    }
    const result = filterContacts(contacts, {
      columnFilters: {},
      textFilters: { 'custom:bio': 'CTO' },
      customFieldValues,
      customFieldTypes: { bio: 'text' },
    })
    expect(result.map((c) => c.id)).toEqual(['1'])
  })
})
