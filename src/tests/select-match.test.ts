/**
 * Tests for the shared select-option matcher (packages/services/src/select-match.ts).
 *
 * This matcher snaps an LLM-emitted value to a select/multiselect field's option
 * list. It replaced the old company-side naive substring fallback that let
 * unrelated values bleed into the wrong field (e.g. a sector like "LegalTech"
 * landing in a custom "Pipeline Stage" field). Coverage here guards BOTH:
 *   • negative — cross-field junk no longer matches (the original bug)
 *   • positive — legitimate values still match (no over-tightening / silent
 *     under-fill)
 */

import { describe, it, expect } from 'vitest'
import { matchSelectOption } from '@cyggie/services/select-match'

const STAGES = ['Pre-Seed', 'Seed', 'Series A', 'Series B']
const SECTORS = ['FinTech', 'LegalTech', 'HealthTech']

describe('matchSelectOption — negative (cross-field junk rejected)', () => {
  it('does not snap a sector value into a stage option list', () => {
    expect(matchSelectOption('LegalTech', STAGES)).toBeNull()
  })

  it('does not snap a stage value into a sector option list', () => {
    expect(matchSelectOption('Series A', SECTORS)).toBeNull()
  })

  it('"Seed" no longer bleeds into the longer "Pre-Seed" option', () => {
    // Exact "Seed" must win; it must never fuzzy-match "Pre-Seed".
    expect(matchSelectOption('Seed', ['Pre-Seed'])).toBeNull()
  })

  it('returns null for completely unrelated text', () => {
    expect(matchSelectOption('the founder mentioned hiring', STAGES)).toBeNull()
  })

  it('returns null for empty / whitespace input', () => {
    expect(matchSelectOption('', STAGES)).toBeNull()
    expect(matchSelectOption('   ', STAGES)).toBeNull()
  })
})

describe('matchSelectOption — positive (legitimate values still match)', () => {
  it('matches an exact option', () => {
    expect(matchSelectOption('Seed', STAGES)).toBe('Seed')
  })

  it('matches case-insensitively', () => {
    expect(matchSelectOption('series a', STAGES)).toBe('Series A')
  })

  it('tolerates surrounding whitespace', () => {
    expect(matchSelectOption('  Seed  ', STAGES)).toBe('Seed')
  })

  it('tolerates a minor typo within the fuzzy threshold', () => {
    expect(matchSelectOption('LegalTec', SECTORS)).toBe('LegalTech')
  })

  it('prefers the exact option over a near neighbor', () => {
    expect(matchSelectOption('Seed', STAGES)).toBe('Seed')
  })
})
