import { describe, expect, test } from 'vitest'
import { dedupAttendeesByName, dedupResolvedAttendees, type AttendeeContactMap } from '../attendees'

describe('dedupResolvedAttendees', () => {
  test('empty attendees returns []', () => {
    expect(dedupResolvedAttendees([], [], {})).toEqual([])
  })

  test('all unresolved passes through with contactId null', () => {
    const out = dedupResolvedAttendees(
      ['Alice', 'Bob'],
      ['a@x.com', 'b@x.com'],
      {},
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.contactId)).toEqual([null, null])
    expect(out.map((r) => r.name)).toEqual(['Alice', 'Bob'])
  })

  test('two attendees resolving to same contactId collapse to first', () => {
    const map: AttendeeContactMap = {
      'a@x.com': { id: '1', fullName: 'Alice' },
      'b@x.com': { id: '1', fullName: 'Alice' },
    }
    const out = dedupResolvedAttendees(
      ['Alice', 'Alice'],
      ['a@x.com', 'b@x.com'],
      map,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ index: 0, email: 'a@x.com', contactId: '1' })
  })

  test('different contactIds both pass through', () => {
    const map: AttendeeContactMap = {
      'a@x.com': { id: '1', fullName: 'Alice' },
      'b@x.com': { id: '2', fullName: 'Bob' },
    }
    const out = dedupResolvedAttendees(
      ['Alice', 'Bob'],
      ['a@x.com', 'b@x.com'],
      map,
    )
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.contactId)).toEqual(['1', '2'])
  })

  test('unresolved always passes through alongside resolved dedup', () => {
    const map: AttendeeContactMap = {
      'a@x.com': { id: '1', fullName: 'Alice' },
      'b@x.com': { id: '1', fullName: 'Alice' },
    }
    const out = dedupResolvedAttendees(
      ['Alice', 'Alice', 'Stranger'],
      ['a@x.com', 'b@x.com', 'stranger@x.com'],
      map,
    )
    expect(out).toHaveLength(2)
    expect(out[0].contactId).toBe('1')
    expect(out[1].contactId).toBeNull()
    expect(out[1].email).toBe('stranger@x.com')
  })

  test('middle dup is skipped; order of outer rows preserved', () => {
    const map: AttendeeContactMap = {
      'a@x.com': { id: '1', fullName: 'Alice' },
      'b@x.com': { id: '1', fullName: 'Alice' },
      'c@x.com': { id: '2', fullName: 'Carol' },
    }
    const out = dedupResolvedAttendees(
      ['Alice', 'Alice', 'Carol'],
      ['a@x.com', 'b@x.com', 'c@x.com'],
      map,
    )
    expect(out.map((r) => r.index)).toEqual([0, 2])
    expect(out.map((r) => r.contactId)).toEqual(['1', '2'])
  })

  test('missing attendeeEmails entry falls back to name lookup', () => {
    const map: AttendeeContactMap = {
      'alice': { id: '1', fullName: 'Alice' },
    }
    const out = dedupResolvedAttendees(
      ['Alice'],
      undefined,
      map,
    )
    expect(out).toHaveLength(1)
    expect(out[0].contactId).toBe('1')
    expect(out[0].email).toBe('')
  })
})

describe('dedupAttendeesByName', () => {
  test('collapses same-name attendees regardless of email', () => {
    const out = dedupAttendeesByName(['Alice', 'Alice', 'Bob'], ['a@x', 'b@x', 'bob@x'])
    expect(out).toHaveLength(2)
    expect(out.map((r) => r.name)).toEqual(['Alice', 'Bob'])
  })

  test('case-insensitive name dedup', () => {
    const out = dedupAttendeesByName(['Alice Smith', 'alice smith'])
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('Alice Smith')
  })

  test('empty name does not dedup against another empty name', () => {
    const out = dedupAttendeesByName(['', ''], ['a@x', 'b@x'])
    expect(out).toHaveLength(2)
  })
})
