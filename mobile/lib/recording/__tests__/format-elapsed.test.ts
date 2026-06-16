import { describe, expect, it } from 'vitest'
import { formatElapsed } from '../format-elapsed'

describe('formatElapsed', () => {
  it('formats sub-hour durations as MM:SS', () => {
    expect(formatElapsed(0)).toBe('00:00')
    expect(formatElapsed(5)).toBe('00:05')
    expect(formatElapsed(65)).toBe('01:05')
    expect(formatElapsed(252)).toBe('04:12') // the screenshot value
    expect(formatElapsed(3599)).toBe('59:59')
  })

  it('formats >= 1 hour as H:MM:SS', () => {
    expect(formatElapsed(3600)).toBe('1:00:00')
    expect(formatElapsed(3661)).toBe('1:01:01')
  })

  it('clamps negative / fractional input', () => {
    expect(formatElapsed(-5)).toBe('00:00')
    expect(formatElapsed(9.9)).toBe('00:09')
  })
})
