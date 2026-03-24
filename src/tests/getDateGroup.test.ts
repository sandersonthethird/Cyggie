/**
 * Tests for getDateGroup() in Notes.tsx
 *
 * Uses midnight-truncated calendar dates so "Yesterday" means the previous
 * calendar day — not "24 hours ago". A note from 11:50pm yesterday is
 * "Yesterday" even when checked at 12:05am.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getDateGroup } from '../renderer/routes/Notes'

describe('getDateGroup', () => {
  beforeEach(() => {
    // Fix "now" to 2026-03-24 09:00 local time (timezone-safe)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 24, 9, 0, 0))  // March 24, 2026 9am local
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "Today" for a note from today', () => {
    expect(getDateGroup(new Date(2026, 2, 24, 3, 0).toISOString())).toBe('Today')
    expect(getDateGroup(new Date(2026, 2, 24, 8, 59).toISOString())).toBe('Today')
  })

  it('returns "Yesterday" for a note from yesterday (calendar day)', () => {
    expect(getDateGroup(new Date(2026, 2, 23, 12, 0).toISOString())).toBe('Yesterday')
  })

  it('handles midnight boundary: 11:50pm yesterday is Yesterday at 12:05am', () => {
    // "now" is 12:05am local on March 24 — only 15 min since 11:50pm March 23
    vi.setSystemTime(new Date(2026, 2, 24, 0, 5, 0))
    // Note from 11:50pm yesterday
    expect(getDateGroup(new Date(2026, 2, 23, 23, 50).toISOString())).toBe('Yesterday')
  })

  it('returns "This Week" for 3 days ago', () => {
    expect(getDateGroup(new Date(2026, 2, 21, 12, 0).toISOString())).toBe('This Week')
  })

  it('returns "This Month" for 10 days ago', () => {
    expect(getDateGroup(new Date(2026, 2, 14, 12, 0).toISOString())).toBe('This Month')
  })

  it('returns "Older" for 35 days ago', () => {
    expect(getDateGroup(new Date(2026, 1, 17, 12, 0).toISOString())).toBe('Older')
  })

  it('returns "Older" for an invalid date string', () => {
    expect(getDateGroup('not-a-date')).toBe('Older')
  })
})
