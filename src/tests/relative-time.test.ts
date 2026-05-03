import { describe, it, expect } from 'vitest'
import { relativeTime, absoluteTime } from '../renderer/utils/relative-time'

const NOW = new Date(2026, 4, 2, 12, 0, 0)

function localISO(d: Date): string {
  return d.toISOString()
}

describe('relativeTime', () => {
  it('returns "just now" for under 60s', () => {
    expect(relativeTime(localISO(new Date(2026, 4, 2, 11, 59, 59)), NOW)).toBe('just now')
    expect(relativeTime(localISO(new Date(2026, 4, 2, 11, 59, 1)), NOW)).toBe('just now')
  })

  it('returns minutes for under an hour', () => {
    expect(relativeTime(localISO(new Date(2026, 4, 2, 11, 55, 0)), NOW)).toBe('5m ago')
    expect(relativeTime(localISO(new Date(2026, 4, 2, 11, 1, 0)), NOW)).toBe('59m ago')
  })

  it('returns hours for under a day', () => {
    expect(relativeTime(localISO(new Date(2026, 4, 2, 10, 0, 0)), NOW)).toBe('2h ago')
    expect(relativeTime(localISO(new Date(2026, 4, 1, 13, 0, 0)), NOW)).toBe('23h ago')
  })

  it('returns days for under a week', () => {
    expect(relativeTime(localISO(new Date(2026, 4, 1, 12, 0, 0)), NOW)).toBe('1d ago')
    expect(relativeTime(localISO(new Date(2026, 3, 27, 12, 0, 0)), NOW)).toBe('5d ago')
  })

  it('returns weeks for under a month', () => {
    expect(relativeTime(localISO(new Date(2026, 3, 25, 12, 0, 0)), NOW)).toBe('1w ago')
    expect(relativeTime(localISO(new Date(2026, 3, 10, 12, 0, 0)), NOW)).toBe('3w ago')
  })

  it('returns absolute date for over 30 days', () => {
    const out = relativeTime(localISO(new Date(2026, 0, 15, 10, 0, 0)), NOW)
    expect(out).toMatch(/Jan/)
  })

  it('returns "" for invalid ISO', () => {
    expect(relativeTime('not-a-date', NOW)).toBe('')
    expect(relativeTime('', NOW)).toBe('')
  })

  it('returns "just now" for future-dated values (clamped)', () => {
    expect(relativeTime(localISO(new Date(2026, 4, 2, 13, 0, 0)), NOW)).toBe('just now')
  })
})

describe('absoluteTime', () => {
  it('returns a formatted date+time string', () => {
    const out = absoluteTime(localISO(new Date(2026, 4, 2, 12, 0, 0)))
    expect(out).toMatch(/May/)
    expect(out).toMatch(/2/)
  })

  it('returns "" for invalid ISO', () => {
    expect(absoluteTime('not-a-date')).toBe('')
  })
})
