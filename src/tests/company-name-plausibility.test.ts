/**
 * Tests for isPlausibleCompanyName — the gate that stops a marketing tagline
 * scraped from a homepage <title>/og:site_name, or hallucinated by the LLM,
 * from being stored as a company name.
 *
 * Regression: caphub.com once enriched to the tagline "Streamlining The
 * Middle-Market Deal Landscape" instead of "CapHub".
 */

import { describe, it, expect, vi } from 'vitest'

// company-enrichment imports electron + the LLM provider factory at module load.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
vi.mock('@cyggie/services/llm/provider-factory', () => ({ getProvider: () => ({}) }))

const { isPlausibleCompanyName } = await import('../main/services/company-enrichment')

describe('isPlausibleCompanyName', () => {
  it('accepts real company names (including long multi-word ones)', () => {
    for (const name of [
      'CapHub',
      'Stripe',
      'Andreessen Horowitz',
      'Bank of America Merrill Lynch',
      'Sequoia Capital',
      'Y Combinator',
      'JPMorgan Chase & Co',
    ]) {
      expect(isPlausibleCompanyName(name), name).toBe(true)
    }
  })

  it('rejects gerund-led taglines/slogans', () => {
    for (const slogan of [
      'Streamlining The Middle-Market Deal Landscape',
      'Helping Independent Sponsors Maximize Every Opportunity',
      'Empowering Teams To Build Faster',
    ]) {
      expect(isPlausibleCompanyName(slogan), slogan).toBe(false)
    }
  })

  it('rejects sentences and over-long phrases', () => {
    expect(isPlausibleCompanyName('We build software for founders.')).toBe(false)
    expect(isPlausibleCompanyName('The best platform for modern venture capital firms everywhere')).toBe(false)
  })

  it('rejects empty / too-short / too-long values', () => {
    expect(isPlausibleCompanyName('')).toBe(false)
    expect(isPlausibleCompanyName('A')).toBe(false)
    expect(isPlausibleCompanyName('X'.repeat(61))).toBe(false)
  })
})
