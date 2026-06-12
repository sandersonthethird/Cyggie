import { describe, expect, it } from 'vitest'
import {
  classifyLocation,
  extractLocationUrl,
  extractPhoneNumber,
} from './location-classifier'

describe('classifyLocation', () => {
  it('returns "none" for empty / whitespace / null / undefined', () => {
    expect(classifyLocation('')).toBe('none')
    expect(classifyLocation('   ')).toBe('none')
    expect(classifyLocation(null)).toBe('none')
    expect(classifyLocation(undefined)).toBe('none')
  })

  it('classifies physical addresses and room names as in_person', () => {
    expect(classifyLocation('124 Main St, San Francisco, CA')).toBe('in_person')
    expect(classifyLocation('Conference Room B')).toBe('in_person')
    expect(classifyLocation('Blue Bottle Coffee, Hayes Valley')).toBe('in_person')
  })

  it('classifies phone-call instructions as phone (never in_person)', () => {
    expect(classifyLocation('Sandy to call James at 555-555-5555')).toBe('phone')
    expect(classifyLocation('Dial in: +1 (415) 555-0132')).toBe('phone')
    expect(classifyLocation('Phone call')).toBe('phone')
    expect(classifyLocation('call James')).toBe('phone')
  })

  it('classifies pasted conference links as video', () => {
    expect(classifyLocation('https://zoom.us/j/123456789')).toBe('video')
    expect(classifyLocation('https://meet.google.com/abc-defg-hij')).toBe('video')
    expect(classifyLocation('join here: meet.google.com/abc-defg-hij')).toBe('video')
    expect(classifyLocation('https://teams.microsoft.com/l/meetup-join/x')).toBe('video')
  })

  it('prefers video over phone when a dial-in block has both a URL and a number', () => {
    expect(
      classifyLocation('https://zoom.us/j/123 or dial +1 415-555-0132'),
    ).toBe('video')
  })

  it('does not trip the call keyword on substrings like "recall" / "callout"', () => {
    expect(classifyLocation('Recall HQ, 5th floor')).toBe('in_person')
    expect(classifyLocation('Callout Brewing Co')).toBe('in_person')
  })
})

describe('extractPhoneNumber', () => {
  it('pulls a US number as digits', () => {
    expect(extractPhoneNumber('Sandy to call James at 555-555-5555')).toBe('5555555555')
  })

  it('preserves the leading + for international numbers', () => {
    expect(extractPhoneNumber('Dial +1 (415) 555-0132')).toBe('+14155550132')
  })

  it('returns null when there is no number', () => {
    expect(extractPhoneNumber('Phone call')).toBeNull()
    expect(extractPhoneNumber(null)).toBeNull()
  })
})

describe('extractLocationUrl', () => {
  it('returns a full http(s) URL as-is', () => {
    expect(extractLocationUrl('join: https://zoom.us/j/123')).toBe('https://zoom.us/j/123')
  })

  it('prefixes https:// onto a bare conference domain', () => {
    expect(extractLocationUrl('meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    )
  })

  it('returns null when there is no URL', () => {
    expect(extractLocationUrl('124 Main St')).toBeNull()
  })
})
