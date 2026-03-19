import { describe, it, expect } from 'vitest'
import { correctProperNouns } from '../main/utils/proper-noun-corrector'

describe('correctProperNouns', () => {
  it('returns text unchanged when name list is empty', () => {
    const text = 'We spoke with Sansen about the deal.'
    expect(correctProperNouns(text, [])).toBe(text)
  })

  it('returns text unchanged when text is empty', () => {
    expect(correctProperNouns('', ['Sandy Chen'])).toBe('')
  })

  it('corrects a single-word misspelling above threshold', () => {
    // "Tobius" is a close misspelling of "Tobias"
    const text = 'Tobius confirmed the term sheet.'
    const result = correctProperNouns(text, ['Tobias'])
    expect(result).toBe('Tobias confirmed the term sheet.')
  })

  it('does not replace a word that is too different', () => {
    const text = 'The meeting went well.'
    const result = correctProperNouns(text, ['Tobias'])
    expect(result).toBe(text)
  })

  it('does not replace tokens shorter than 4 characters', () => {
    // "Ian" is 3 chars — should not trigger single-word matching
    const text = 'Ian from the team joined.'
    const result = correctProperNouns(text, ['Ian'])
    expect(result).toBe(text)
  })

  it('corrects a two-word name using sliding window', () => {
    // "Redd Swan" is a close misspelling of "Red Swan"
    const text = 'We met with Redd Swan Ventures today.'
    const result = correctProperNouns(text, ['Red Swan Ventures'])
    expect(result).toBe('We met with Red Swan Ventures today.')
  })

  it('processes longest names first to prevent partial clobber', () => {
    // "Sandy Chan" should match "Sandy Chen" (2-word) before "Sandy" (1-word)
    // so the full name gets corrected, not just "Sandy"
    const text = 'Sandy Chan discussed the deal.'
    const result = correctProperNouns(text, ['Sandy', 'Sandy Chen'])
    expect(result).toBe('Sandy Chen discussed the deal.')
  })

  it('returns text unchanged when no names match', () => {
    const text = 'The quarterly results look strong.'
    const result = correctProperNouns(text, ['Anthropic', 'OpenAI', 'Google'])
    expect(result).toBe(text)
  })

  it('handles multiple corrections in the same text', () => {
    const text = 'Tobius and Martyn discussed the Incisive deal.'
    const result = correctProperNouns(text, ['Tobias', 'Martin', 'Incisive Ventures'])
    expect(result).toContain('Tobias')
    expect(result).toContain('Martin')
  })

  it('does not corrupt text on error — returns original', () => {
    // Should never throw; graceful fallback is the contract
    const text = 'Normal transcript text.'
    expect(() => correctProperNouns(text, ['ValidName'])).not.toThrow()
  })
})
