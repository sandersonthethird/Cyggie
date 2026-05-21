import { describe, expect, it } from 'vitest'
import {
  decideSaveLabel,
  formatRelative,
  shouldEnqueueSave,
} from '../notes-editor-state'

const NOW = Date.parse('2026-05-21T12:00:00Z')

describe('decideSaveLabel', () => {
  it('returns "Saving…" for pending status with 1 entry', () => {
    expect(
      decideSaveLabel({
        status: 'pending',
        pendingCount: 1,
        lastSavedAtMs: null,
        nowMs: NOW,
      }),
    ).toEqual({ text: 'Saving…', isWarning: false })
  })

  it('returns "Saving (N)…" when more than one pending', () => {
    expect(
      decideSaveLabel({
        status: 'pending',
        pendingCount: 3,
        lastSavedAtMs: null,
        nowMs: NOW,
      }),
    ).toEqual({ text: 'Saving (3)…', isWarning: false })
  })

  it('shows "Saved" briefly after a successful save', () => {
    expect(
      decideSaveLabel({
        status: 'idle',
        pendingCount: 0,
        lastSavedAtMs: NOW - 5_000,
        nowMs: NOW,
      }),
    ).toEqual({ text: 'Saved', isWarning: false })
  })

  it('drops the "Saved" label past the recency window', () => {
    expect(
      decideSaveLabel({
        status: 'idle',
        pendingCount: 0,
        lastSavedAtMs: NOW - 90_000,
        nowMs: NOW,
      }).text,
    ).toBe('')
  })

  it('returns warning on error with no retries', () => {
    expect(
      decideSaveLabel({
        status: 'error',
        pendingCount: 0,
        lastSavedAtMs: null,
        nowMs: NOW,
      }),
    ).toEqual({ text: 'Save failed', isWarning: true })
  })

  it('returns retry banner when retries > 0', () => {
    expect(
      decideSaveLabel({
        status: 'error',
        pendingCount: 0,
        lastSavedAtMs: null,
        nowMs: NOW,
        retries: 3,
      }),
    ).toEqual({ text: 'Retrying… (attempt 3)', isWarning: false })
  })
})

describe('formatRelative', () => {
  it('returns "just now" for very recent timestamps', () => {
    const iso = new Date(NOW - 2_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('just now')
  })

  it('returns seconds for sub-minute ages', () => {
    const iso = new Date(NOW - 30_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('30 seconds ago')
  })

  it('returns "5 minutes ago" for minute-scale ages', () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('5 minutes ago')
  })

  it('singularizes "1 minute ago"', () => {
    const iso = new Date(NOW - 60_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('1 minute ago')
  })

  it('returns "1 hour ago" / hours for sub-day ages', () => {
    const iso = new Date(NOW - 60 * 60_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('1 hour ago')
    const iso2 = new Date(NOW - 5 * 60 * 60_000).toISOString()
    expect(formatRelative(iso2, NOW)).toBe('5 hours ago')
  })

  it('returns "yesterday" for 1 day', () => {
    const iso = new Date(NOW - 24 * 60 * 60_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('yesterday')
  })

  it('returns "" for unparseable input', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('')
  })

  it('treats future timestamps as "just now" (clock skew)', () => {
    const iso = new Date(NOW + 5_000).toISOString()
    expect(formatRelative(iso, NOW)).toBe('just now')
  })
})

describe('shouldEnqueueSave', () => {
  it('returns false when latest matches last enqueued', () => {
    expect(
      shouldEnqueueSave({
        latest: 'same text',
        lastEnqueued: 'same text',
        serverValue: 'old',
      }),
    ).toBe(false)
  })

  it('returns false when latest matches server value (no-op round-trip)', () => {
    expect(
      shouldEnqueueSave({
        latest: 'server value',
        lastEnqueued: 'in-flight',
        serverValue: 'server value',
      }),
    ).toBe(false)
  })

  it('returns true when latest differs from both', () => {
    expect(
      shouldEnqueueSave({
        latest: 'new text',
        lastEnqueued: 'old text',
        serverValue: 'older',
      }),
    ).toBe(true)
  })

  it('treats null + empty as equivalent (no-op when clearing already-null notes)', () => {
    expect(
      shouldEnqueueSave({
        latest: '',
        lastEnqueued: null,
        serverValue: null,
      }),
    ).toBe(false)
  })

  it('trims for comparison', () => {
    expect(
      shouldEnqueueSave({
        latest: '  hi  ',
        lastEnqueued: 'hi',
        serverValue: null,
      }),
    ).toBe(false)
  })
})
