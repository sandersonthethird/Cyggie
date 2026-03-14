import { describe, it, expect } from 'vitest'
import { formatCurrency, formatDate, daysSince } from '../renderer/utils/format'

describe('formatCurrency', () => {
  it('returns — for null', () => {
    expect(formatCurrency(null)).toBe('—')
  })

  it('returns — for undefined', () => {
    expect(formatCurrency(undefined)).toBe('—')
  })

  it('formats billions', () => {
    expect(formatCurrency(1_500_000_000)).toBe('$1.5B')
  })

  it('formats millions', () => {
    expect(formatCurrency(2_400_000)).toBe('$2.4M')
  })

  it('formats thousands', () => {
    expect(formatCurrency(500_000)).toBe('$500K')
  })

  it('formats sub-thousand values', () => {
    expect(formatCurrency(999)).toBe('$999')
  })

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0')
  })

  it('formats negative millions', () => {
    expect(formatCurrency(-3_200_000)).toBe('-$3.2M')
  })

  it('formats negative thousands', () => {
    expect(formatCurrency(-75_000)).toBe('-$75K')
  })

  it('handles exact 1B boundary', () => {
    expect(formatCurrency(1_000_000_000)).toBe('$1.0B')
  })

  it('handles exact 1M boundary', () => {
    expect(formatCurrency(1_000_000)).toBe('$1.0M')
  })

  it('handles exact 1K boundary', () => {
    expect(formatCurrency(1_000)).toBe('$1K')
  })
})

describe('formatDate', () => {
  it('returns — for null', () => {
    expect(formatDate(null)).toBe('—')
  })

  it('returns — for undefined', () => {
    expect(formatDate(undefined)).toBe('—')
  })

  it('returns — for empty string', () => {
    expect(formatDate('')).toBe('—')
  })

  it('formats a valid ISO date string', () => {
    // Use noon local time to avoid UTC-midnight timezone shift (Jun 15 UTC → Jun 14 in western zones)
    const result = formatDate('2024-06-15T12:00:00')
    expect(result).toMatch(/Jun/)
    expect(result).toMatch(/15/)
    expect(result).toMatch(/2024/)
  })
})

describe('daysSince', () => {
  it('returns null for null', () => {
    expect(daysSince(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(daysSince(undefined)).toBeNull()
  })

  it('returns 0 for today', () => {
    const today = new Date().toISOString()
    expect(daysSince(today)).toBe(0)
  })

  it('returns approximately 1 for yesterday', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    expect(daysSince(yesterday)).toBe(1)
  })

  it('returns approximately 7 for a week ago', () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    expect(daysSince(weekAgo)).toBe(7)
  })
})
