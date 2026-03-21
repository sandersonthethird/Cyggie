import { describe, it, expect } from 'vitest'
import { normalizeToken, splitCamelCase } from '../main/utils/string-utils'

describe('normalizeToken', () => {
  it('lowercases and strips spaces', () => {
    expect(normalizeToken('Acme Corp')).toBe('acmecorp')
  })

  it('strips punctuation and special chars', () => {
    expect(normalizeToken('Red Swan Ventures')).toBe('redswanventures')
  })

  it('handles empty string', () => {
    expect(normalizeToken('')).toBe('')
  })

  it('handles null-ish values', () => {
    expect(normalizeToken(null as unknown as string)).toBe('')
    expect(normalizeToken(undefined as unknown as string)).toBe('')
  })

  it('keeps digits', () => {
    expect(normalizeToken('Acme1 Corp')).toBe('acme1corp')
  })
})

describe('splitCamelCase', () => {
  it('splits CamelCase into space-separated words', () => {
    expect(splitCamelCase('AcmeCorp')).toBe('Acme Corp')
  })

  it('handles multi-split', () => {
    expect(splitCamelCase('BowleyCapitalVentures')).toBe('Bowley Capital Ventures')
  })

  it('preserves all-uppercase (abbreviations)', () => {
    expect(splitCamelCase('IBM')).toBe('IBM')
    expect(splitCamelCase('IDEO')).toBe('IDEO')
  })

  it('preserves all-lowercase (no CamelCase)', () => {
    expect(splitCamelCase('acmecorp')).toBe('acmecorp')
  })

  it('splits mixed case with OpenAI-style', () => {
    expect(splitCamelCase('OpenAI')).toBe('Open AI')
  })

  it('handles empty string', () => {
    expect(splitCamelCase('')).toBe('')
  })
})
