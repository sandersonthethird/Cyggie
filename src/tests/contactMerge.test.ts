import { describe, it, expect } from 'vitest'
import { selectMergeKeepId } from '../renderer/utils/contactMerge'
import type { ContactSummary } from '../shared/types/contact'

function makeContact(id: string, meetingCount: number, emailCount: number): ContactSummary {
  return {
    id,
    fullName: id,
    firstName: null,
    lastName: null,
    normalizedName: id,
    email: null,
    primaryCompanyId: null,
    primaryCompanyName: null,
    title: null,
    contactType: null,
    linkedinUrl: null,
    crmContactId: null,
    crmProvider: null,
    meetingCount,
    emailCount,
    lastTouchpoint: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z'
  }
}

describe('selectMergeKeepId', () => {
  it('returns the contact with the most meetings', () => {
    const contacts = [makeContact('a', 1, 0), makeContact('b', 5, 0)]
    expect(selectMergeKeepId(contacts)).toBe('b')
  })

  it('returns the contact with the most emails when meetings are equal', () => {
    const contacts = [makeContact('a', 2, 1), makeContact('b', 2, 10)]
    expect(selectMergeKeepId(contacts)).toBe('b')
  })

  it('uses total engagement (meetings + emails) for comparison', () => {
    const contacts = [makeContact('a', 3, 0), makeContact('b', 1, 5)]
    // b has 6 total vs a's 3 total
    expect(selectMergeKeepId(contacts)).toBe('b')
  })

  it('returns the first contact when all have equal engagement (tie-break)', () => {
    const contacts = [makeContact('first', 2, 2), makeContact('second', 2, 2)]
    expect(selectMergeKeepId(contacts)).toBe('first')
  })

  it('works with a single contact', () => {
    const contacts = [makeContact('only', 0, 0)]
    expect(selectMergeKeepId(contacts)).toBe('only')
  })

  it('works with 3+ contacts', () => {
    const contacts = [
      makeContact('a', 1, 0),
      makeContact('b', 0, 0),
      makeContact('c', 3, 5)
    ]
    expect(selectMergeKeepId(contacts)).toBe('c')
  })

  it('throws on empty array', () => {
    expect(() => selectMergeKeepId([])).toThrow('contacts must be non-empty')
  })
})
