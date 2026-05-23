import { describe, expect, it } from 'vitest'
import { attendeeLabel } from '../attendee'

describe('attendeeLabel', () => {
  it('returns the contact full name when matched', () => {
    expect(
      attendeeLabel({
        name: 'alice@example.com',
        email: 'alice@example.com',
        contactId: 'c_1',
        contactFullName: 'Alice Smith',
      }),
    ).toBe('Alice Smith')
  })

  it('falls back to the calendar name when no contact and name differs from email', () => {
    expect(
      attendeeLabel({
        name: 'Bob Jones',
        email: 'bob@example.com',
        contactId: null,
        contactFullName: null,
      }),
    ).toBe('Bob Jones')
  })

  it('falls back to email when calendar name is just the email', () => {
    expect(
      attendeeLabel({
        name: 'carol@example.com',
        email: 'carol@example.com',
        contactId: null,
        contactFullName: null,
      }),
    ).toBe('carol@example.com')
  })

  it('returns Unknown when everything is missing', () => {
    expect(
      attendeeLabel({
        name: '',
        email: null,
        contactId: null,
        contactFullName: null,
      }),
    ).toBe('Unknown')
  })
})
