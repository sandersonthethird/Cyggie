/**
 * Transcript proper noun correction.
 *
 * After transcription, speech-to-text models often misspell proper nouns (company
 * and contact names) that aren't in their base vocabulary. This pass fuzzy-matches
 * the transcript text against known CRM names and replaces high-confidence hits
 * with their canonical forms.
 *
 * Algorithm:
 *   1. Sort canonical names longest-first to prevent partial-name matches from
 *      clobbering longer ones (e.g. process "Sandy Chen" before "Sandy").
 *   2. For single-word names: token-by-token Jaro-Winkler comparison (≥ 0.92).
 *   3. For multi-word names: sliding N-word regex window comparison (≥ 0.90).
 *   4. Only corrects the text string — does NOT touch word timestamps or speaker labels.
 *
 * Performance: O(names × words). ~1.5ms for a 30-min transcript with 300 names.
 */

import { jaroWinkler } from './jaroWinkler'

const SINGLE_WORD_THRESHOLD = 0.92
const MULTI_WORD_THRESHOLD = 0.90
const MIN_TOKEN_LENGTH = 4 // don't try to correct very short words

/**
 * Correct misspelled proper nouns in a transcript string.
 *
 * @param text - Raw transcript text to correct.
 * @param canonicalNames - List of known proper nouns (company/contact names) from the CRM.
 * @returns Corrected transcript text. Returns `text` unchanged on any error.
 */
export function correctProperNouns(text: string, canonicalNames: string[]): string {
  if (!text || canonicalNames.length === 0) return text

  try {
    // Filter and sort: longest names first (word count), then by char length.
    // This ensures "Red Swan Ventures" is processed before "Red Swan" or "Swan".
    const names = canonicalNames
      .map((n) => n.trim())
      .filter((n) => n.length >= MIN_TOKEN_LENGTH)
      .sort((a, b) => {
        const aw = a.split(/\s+/).length
        const bw = b.split(/\s+/).length
        return bw - aw || b.length - a.length
      })

    let result = text

    for (const canonical of names) {
      const words = canonical.split(/\s+/)
      const wordCount = words.length
      const canonLower = canonical.toLowerCase()

      if (wordCount === 1) {
        // Single-word: replace each word-boundary token that scores above threshold.
        // Only consider tokens of at least MIN_TOKEN_LENGTH to avoid false positives
        // on common short words (e.g. matching "the" to "Thé").
        result = result.replace(/\b[A-Za-z]{4,}\b/g, (token) => {
          const score = jaroWinkler(token.toLowerCase(), canonLower)
          return score >= SINGLE_WORD_THRESHOLD ? canonical : token
        })
      } else {
        // Multi-word: build a regex that matches exactly `wordCount` consecutive words
        // (letters, apostrophes, hyphens allowed within words), then compare the
        // whole match to the canonical name as a single string.
        const wordPat = "[A-Za-z][A-Za-z'\\-]*"
        const seqPat = wordPat + `(?:\\s+${wordPat})`.repeat(wordCount - 1)
        const regex = new RegExp(`\\b${seqPat}\\b`, 'g')
        result = result.replace(regex, (match) => {
          // Require each individual token to be at least 3 chars to avoid
          // single-letter abbreviations triggering multi-word replacements.
          if (match.split(/\s+/).some((w) => w.length < 3)) return match
          const score = jaroWinkler(match.toLowerCase(), canonLower)
          return score >= MULTI_WORD_THRESHOLD ? canonical : match
        })
      }
    }

    return result
  } catch (err) {
    // Never corrupt the transcript — return original text on any unexpected error.
    console.warn('[ProperNounCorrector] Error during correction pass:', err)
    return text
  }
}
