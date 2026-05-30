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
    // "Tobiass" → "Tobias" at JW ≈ 0.971, just above the 0.97 threshold.
    const text = 'Tobiass confirmed the term sheet.'
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
    // Use misspellings whose JW ≥ 0.97 (threshold raised 2026-05-30).
    // - "Tobiass" → "Tobias" (JW ≈ 0.971)
    // - "Anthropi" → "Anthropic" (JW ≈ 0.978)
    const text = 'Tobiass spoke with Anthropi about the deal.'
    const result = correctProperNouns(text, ['Tobias', 'Anthropic'])
    expect(result).toContain('Tobias')
    expect(result).toContain('Anthropic')
  })

  it('does not corrupt text on error — returns original', () => {
    // Should never throw; graceful fallback is the contract
    const text = 'Normal transcript text.'
    expect(() => correctProperNouns(text, ['ValidName'])).not.toThrow()
  })

  it('does not replace email local parts that fuzzy-match a CRM name', () => {
    // "sandy" in "sandy@redswanventures.com" should not become "Andy"
    // even though jaroWinkler("sandy", "andy") ≈ 0.933 > 0.92 threshold
    const text = '**sandy@redswanventures.com** [0:00]\nCoding and investing.'
    const result = correctProperNouns(text, ['Andy'])
    expect(result).toContain('sandy@redswanventures.com')
  })

  it('does not replace email domain parts that fuzzy-match a CRM name', () => {
    const text = 'Contact info@Promptcapital.com for details.'
    const result = correctProperNouns(text, ['PromptCapital'])
    expect(result).toContain('info@Promptcapital.com')
  })

  it('still corrects non-email words that fuzzy-match a CRM name', () => {
    // "Tobiass" → "Tobias" at JW ≈ 0.971 (above 0.97 threshold).
    // Regression: email guard must not block non-email tokens.
    const text = 'Tobiass discussed the deal with the team.'
    const result = correctProperNouns(text, ['Tobias'])
    expect(result).toBe('Tobias discussed the deal with the team.')
  })

  // ── Sandy/Andy regression suite (2026-05-28) ─────────────────────────────
  // Originally reported: user "Sandy Cass" had every transcript rewrite
  // "Sandy" to "Andy" because a colleague named "Andy" is in the CRM and
  // JW("sandy","andy") ≈ 0.933 > 0.92 (the old threshold). Fix: canonical-
  // token guard — a token that is itself a known canonical name (lowercased,
  // ≥ MIN_TOKEN_LENGTH) is never fuzzy-replaced into a different canonical.
  //
  // After the 2026-05-30 threshold raise (0.92 → 0.97), JW("sandy","andy")
  // ≈ 0.933 no longer triggers regardless of the guard, so the bug is
  // defended in depth: threshold + canonical guard. These tests still pass
  // and protect against future threshold relaxations.

  it('does not rewrite a name that is itself a canonical token (Sandy/Andy)', () => {
    const text = 'Sandy joined the call.'
    const result = correctProperNouns(text, ['Andy', 'Sandy Cass'])
    expect(result).toContain('Sandy')
    expect(result).not.toContain('Andy')
  })

  it('symmetric protection — Andy unchanged when both are canonical tokens', () => {
    const text = 'Andy spoke first.'
    const result = correctProperNouns(text, ['Sandy Cass', 'Andy'])
    expect(result).toContain('Andy')
    expect(result).not.toContain('Sandy')
  })

  it('guard does not over-block — Anthropi still corrects to Anthropic', () => {
    // "anthropi" is NOT in the canonical-token set (only the 9-char
    // "anthropic" is), so fuzzy fallback runs. JW("anthropi","anthropic")
    // ≈ 0.978, above the 0.97 threshold.
    const text = 'Anthropi released a new model.'
    const result = correctProperNouns(text, ['Anthropic'])
    expect(result).toBe('Anthropic released a new model.')
  })

  it('reverse direction — Andy never gets fuzzy-promoted to Sandy', () => {
    const text = 'Andy joined.'
    const result = correctProperNouns(text, ['Sandy', 'Andy'])
    expect(result).toContain('Andy')
    expect(result).not.toContain('Sandy')
  })

  // ── 2026-05-30 threshold raise (0.92 → 0.97) ────────────────────────────
  // Reported: CRM company/contact names like "Smore" and "Buncha" caused the
  // corrector to rewrite common English words ("more" → "Smore",
  // "bunch" → "Buncha"). Raising the single-word threshold to 0.97 prevents
  // both. The trade-off: we lose some legitimate fuzzy corrections (e.g.
  // "Anthrop" → "Anthropic" at JW ≈ 0.956 no longer fires). Acceptable.

  it('does not rewrite "more" to "Smore" (Smore in CRM)', () => {
    // JW("more","smore") ≈ 0.933 — below new 0.97 threshold.
    const text = 'There were more deals than expected.'
    const result = correctProperNouns(text, ['Smore'])
    expect(result).toBe(text)
  })

  it('does not rewrite "bunch" to "Buncha" (Buncha in CRM)', () => {
    // JW("bunch","buncha") ≈ 0.967 — below new 0.97 threshold.
    const text = 'We saw a bunch of inbound leads.'
    const result = correctProperNouns(text, ['Buncha'])
    expect(result).toBe(text)
  })

  it('boundary: "Anthrop" no longer corrects to "Anthropic" at the new threshold', () => {
    // JW("anthrop","anthropic") ≈ 0.956 — below new 0.97 threshold.
    // Documents the trade-off: some legitimate close-misspellings stop
    // correcting. If real users hit this regularly, escalate to TODOS
    // "Per-word confidence-gated CRM rewriting".
    const text = 'Anthrop is an AI lab.'
    const result = correctProperNouns(text, ['Anthropic'])
    expect(result).toBe(text)
  })

  it('still corrects very-close misspellings: "Anthropics" → "Anthropic"', () => {
    // JW("anthropics","anthropic") ≈ 0.980 — well above 0.97.
    const text = 'Anthropics is our favorite lab.'
    const result = correctProperNouns(text, ['Anthropic'])
    expect(result).toBe('Anthropic is our favorite lab.')
  })
})
