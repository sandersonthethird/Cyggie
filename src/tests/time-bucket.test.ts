import { describe, it, expect } from 'vitest'
import { bucketFor, bucketHeaderRange } from '../renderer/utils/time-bucket'

// Use local-time Date constructors so tests are timezone-stable.
// 2026-05-02 is a Saturday. The helper buckets in local time (not UTC).
const NOW = new Date(2026, 4, 2, 12, 0, 0)

function localISO(d: Date): string {
  // Returns an ISO-like string the helper can re-parse to the same local moment.
  // Using Date directly via .toISOString() would shift to UTC; we want a string
  // that parses back to the same local timestamp regardless of TZ.
  return d.toISOString()
}

describe('bucketFor', () => {
  it('returns "today" for an iso later today', () => {
    expect(bucketFor(localISO(new Date(2026, 4, 2, 1, 0, 0)), NOW)).toBe('today')
    expect(bucketFor(localISO(new Date(2026, 4, 2, 23, 59, 0)), NOW)).toBe('today')
  })

  it('returns "yesterday" for the day before', () => {
    expect(bucketFor(localISO(new Date(2026, 4, 1, 18, 0, 0)), NOW)).toBe('yesterday')
    expect(bucketFor(localISO(new Date(2026, 4, 1, 0, 0, 1)), NOW)).toBe('yesterday')
  })

  it('returns "thisWeek" for earlier days in the same Mon-anchored week', () => {
    // Saturday's week starts Monday 2026-04-27. Tue 2026-04-28 should bucket as thisWeek.
    expect(bucketFor(localISO(new Date(2026, 3, 28, 10, 0, 0)), NOW)).toBe('thisWeek')
    expect(bucketFor(localISO(new Date(2026, 3, 30, 10, 0, 0)), NOW)).toBe('thisWeek')
    // Monday boundary itself
    expect(bucketFor(localISO(new Date(2026, 3, 27, 0, 0, 1)), NOW)).toBe('thisWeek')
  })

  it('returns "lastWeek" for the previous Mon-Sun week', () => {
    expect(bucketFor(localISO(new Date(2026, 3, 26, 10, 0, 0)), NOW)).toBe('lastWeek') // last Sun
    expect(bucketFor(localISO(new Date(2026, 3, 20, 10, 0, 0)), NOW)).toBe('lastWeek') // last Mon
  })

  it('returns "earlier" for older entries', () => {
    expect(bucketFor(localISO(new Date(2026, 3, 19, 10, 0, 0)), NOW)).toBe('earlier')
    expect(bucketFor(localISO(new Date(2025, 11, 31, 10, 0, 0)), NOW)).toBe('earlier')
  })

  it('handles invalid ISO strings by bucketing to "earlier" (no throw)', () => {
    expect(bucketFor('not-a-date', NOW)).toBe('earlier')
    expect(bucketFor('', NOW)).toBe('earlier')
  })

  it('handles Sunday-as-now correctly (week starts Monday)', () => {
    // Sunday 2026-05-03
    const sunday = new Date(2026, 4, 3, 12, 0, 0)
    // Monday two days ago (same week)
    expect(bucketFor(localISO(new Date(2026, 3, 27, 10, 0, 0)), sunday)).toBe('thisWeek')
    // Saturday yesterday
    expect(bucketFor(localISO(new Date(2026, 4, 2, 10, 0, 0)), sunday)).toBe('yesterday')
  })

  it('handles Monday-as-now correctly (this week starts today)', () => {
    // Monday 2026-04-27
    const monday = new Date(2026, 3, 27, 12, 0, 0)
    expect(bucketFor(localISO(new Date(2026, 3, 27, 1, 0, 0)), monday)).toBe('today')
    expect(bucketFor(localISO(new Date(2026, 3, 26, 18, 0, 0)), monday)).toBe('yesterday')
    // Saturday before that is last week
    expect(bucketFor(localISO(new Date(2026, 3, 25, 10, 0, 0)), monday)).toBe('lastWeek')
  })
})

describe('bucketHeaderRange', () => {
  it('returns the absolute date for today/yesterday', () => {
    expect(bucketHeaderRange('today', NOW)).toMatch(/Sat.*May.*2/)
    expect(bucketHeaderRange('yesterday', NOW)).toMatch(/Fri.*May.*1/)
  })

  it('returns a date range string for thisWeek', () => {
    // thisWeek = Mon Apr 27 .. Thu Apr 30 (today is Sat, yesterday is Fri)
    const r = bucketHeaderRange('thisWeek', NOW)
    expect(r).toMatch(/Apr/)
    expect(r).toContain('–')
  })

  it('returns "" for thisWeek when today is Mon (no earlier days in week)', () => {
    const monday = new Date(2026, 3, 27, 12, 0, 0)
    expect(bucketHeaderRange('thisWeek', monday)).toBe('')
  })

  it('returns a date range string for lastWeek', () => {
    const r = bucketHeaderRange('lastWeek', NOW)
    expect(r).toContain('–')
  })

  it('returns "" for "earlier"', () => {
    expect(bucketHeaderRange('earlier', NOW)).toBe('')
  })
})
