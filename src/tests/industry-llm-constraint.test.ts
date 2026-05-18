/**
 * Asserts that LLM industry-emitting prompts are constrained to the canonical
 * list, and that the canonical-validation helpers behave correctly.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { CANONICAL_INDUSTRIES, INDUSTRY_PROMPT_LIST, isCanonicalIndustry, normalizeIndustryOrNull } from '../shared/constants/industries'

const SUMMARY_SYNC_PATH = resolve(__dirname, '../../packages/services/src/company-summary-sync.service.ts')
const PITCH_DECK_PATH = resolve(__dirname, '../main/services/pitch-deck-ingestion.service.ts')

describe('industry constants', () => {
  it('INDUSTRY_PROMPT_LIST joins canonical industries with " | "', () => {
    expect(INDUSTRY_PROMPT_LIST).toBe(CANONICAL_INDUSTRIES.join(' | '))
    expect(INDUSTRY_PROMPT_LIST).toContain('FinTech')
    expect(INDUSTRY_PROMPT_LIST).toContain('Consumer (CPG)')
  })

  it('isCanonicalIndustry accepts canonical values', () => {
    expect(isCanonicalIndustry('FinTech')).toBe(true)
    expect(isCanonicalIndustry('Consumer (CPG)')).toBe(true)
  })

  it('isCanonicalIndustry rejects non-canonical strings', () => {
    expect(isCanonicalIndustry('Foodtech')).toBe(false)
    expect(isCanonicalIndustry('fintech')).toBe(false) // case-sensitive
    expect(isCanonicalIndustry(null)).toBe(false)
    expect(isCanonicalIndustry(undefined)).toBe(false)
  })

  it('normalizeIndustryOrNull returns canonical value or null', () => {
    expect(normalizeIndustryOrNull('FinTech')).toBe('FinTech')
    expect(normalizeIndustryOrNull('  FinTech  ')).toBe('FinTech') // trimmed
    expect(normalizeIndustryOrNull('Foodtech')).toBeNull()
    expect(normalizeIndustryOrNull(null)).toBeNull()
    expect(normalizeIndustryOrNull('')).toBeNull()
  })
})

describe('LLM prompts include canonical industry list', () => {
  it('company-summary-sync.service.ts inlines INDUSTRY_PROMPT_LIST', () => {
    const src = readFileSync(SUMMARY_SYNC_PATH, 'utf-8')
    expect(src).toContain('INDUSTRY_PROMPT_LIST')
    expect(src).toContain('"industry"')
    expect(src).not.toMatch(/"industries":\s*array/)
  })

  it('pitch-deck-ingestion.service.ts inlines INDUSTRY_PROMPT_LIST', () => {
    const src = readFileSync(PITCH_DECK_PATH, 'utf-8')
    expect(src).toContain('INDUSTRY_PROMPT_LIST')
    expect(src).toContain('"industry"')
    expect(src).not.toMatch(/"sector":\s*primary/)
  })
})
