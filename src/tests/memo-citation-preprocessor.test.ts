import { describe, it, expect } from 'vitest'
import {
  preprocessMemoCitations,
  canonicalizeForCitation,
  toSuperscript,
} from '../renderer/lib/memo-citation-preprocessor'
import type { StoredMemoEvidence } from '../shared/types/memo-evidence'

function row(overrides: Partial<StoredMemoEvidence> = {}): StoredMemoEvidence {
  return {
    id: overrides.id ?? 'ev-1',
    versionId: 'v-1',
    claimText: overrides.claimText ?? 'TAM is $50B',
    claimCategory: null,
    sourceType: overrides.sourceType ?? 'web',
    sourceId: null,
    sourceUrl: overrides.sourceUrl ?? 'https://gartner.com/report',
    snippet: overrides.snippet ?? 'Gartner says...',
    confidence: 'high',
    severity: null,
    isCritique: false,
    section: overrides.section ?? null,
    createdAt: '2025-01-01',
  }
}

describe('toSuperscript', () => {
  it('converts single digits to superscript', () => {
    expect(toSuperscript(0)).toBe('⁰')
    expect(toSuperscript(1)).toBe('¹')
    expect(toSuperscript(9)).toBe('⁹')
  })
  it('converts multi-digit numbers to concatenated superscripts', () => {
    expect(toSuperscript(10)).toBe('¹⁰')
    expect(toSuperscript(42)).toBe('⁴²')
    expect(toSuperscript(123)).toBe('¹²³')
  })
  it('handles edge cases gracefully', () => {
    expect(toSuperscript(-1)).toBe('-1')
    expect(toSuperscript(1.5)).toBe('1.5')
  })
})

describe('canonicalizeForCitation', () => {
  it('strips URL fragment', () => {
    expect(canonicalizeForCitation('https://x.com/page#section')).toBe('https://x.com/page')
    expect(canonicalizeForCitation('https://x.com/page#a-b-c')).toBe('https://x.com/page')
  })
  it('returns null for malformed URLs', () => {
    expect(canonicalizeForCitation('not-a-url')).toBeNull()
    expect(canonicalizeForCitation('')).toBeNull()
  })
  it('returns null for non-http(s) protocols', () => {
    expect(canonicalizeForCitation('javascript:alert(1)')).toBeNull()
    expect(canonicalizeForCitation('file:///etc/passwd')).toBeNull()
  })
  it('delegates to canonicalizeUrl semantics (lowercase host, trailing slash strip)', () => {
    expect(canonicalizeForCitation('https://Example.COM/Path/')).toBe('https://example.com/Path')
  })
  it('matches a URL with fragment against an evidence row without one', () => {
    const withFrag = canonicalizeForCitation('https://x.com/page#a')
    const withoutFrag = canonicalizeForCitation('https://x.com/page')
    expect(withFrag).toBe(withoutFrag)
  })
})

describe('preprocessMemoCitations', () => {
  it('replaces a single [source: url] with a superscript-numbered link', () => {
    const markdown = 'Claim A [source: https://gartner.com/report].'
    const { processedMarkdown } = preprocessMemoCitations(markdown, [row()])
    expect(processedMarkdown).toBe('Claim A [¹](https://gartner.com/report).')
  })

  it('numbers multiple unique URLs in order of first appearance', () => {
    const markdown = 'A [source: https://x.com/a]. B [source: https://x.com/b].'
    const evidence = [
      row({ id: 'a', sourceUrl: 'https://x.com/a' }),
      row({ id: 'b', sourceUrl: 'https://x.com/b' }),
    ]
    const { processedMarkdown, citationNumber } = preprocessMemoCitations(markdown, evidence)
    expect(processedMarkdown).toContain('[¹](https://x.com/a)')
    expect(processedMarkdown).toContain('[²](https://x.com/b)')
    expect(citationNumber.get('https://x.com/a')).toBe(1)
    expect(citationNumber.get('https://x.com/b')).toBe(2)
  })

  it('reuses the same number when the same URL is cited twice', () => {
    const markdown = 'A [source: https://x.com/a]. Also [source: https://x.com/a].'
    const { processedMarkdown } = preprocessMemoCitations(markdown, [
      row({ id: 'a', sourceUrl: 'https://x.com/a' }),
    ])
    const matches = processedMarkdown.match(/\[¹\]/g) ?? []
    expect(matches.length).toBe(2)
  })

  it('strips URL fragment when matching: [source: ...#a] still finds evidence with url=...', () => {
    const markdown = 'Claim [source: https://x.com/page#section].'
    const evidence = [row({ sourceUrl: 'https://x.com/page' })]
    const { processedMarkdown, bySource } = preprocessMemoCitations(markdown, evidence)
    expect(processedMarkdown).toContain('[¹](https://x.com/page#section)') // raw url preserved in output
    // bySource is keyed by canonical (fragment-stripped) form
    expect(bySource.has('https://x.com/page')).toBe(true)
  })

  it('still numbers URLs with no matching evidence row (caller suppresses popover)', () => {
    const markdown = 'Claim [source: https://orphan.com/page].'
    const { processedMarkdown, bySource } = preprocessMemoCitations(markdown, [])
    expect(processedMarkdown).toContain('[¹](https://orphan.com/page)')
    expect(bySource.has('https://orphan.com/page')).toBe(false)
  })

  it('leaves markdown without any [source:] markers unchanged', () => {
    const markdown = '# Memo\n\n## Risks\n- something'
    const { processedMarkdown } = preprocessMemoCitations(markdown, [])
    expect(processedMarkdown).toBe(markdown)
  })

  it('handles trailing punctuation after the citation correctly', () => {
    const markdown = 'Claim [source: https://x.com/page], next sentence.'
    const { processedMarkdown } = preprocessMemoCitations(markdown, [
      row({ sourceUrl: 'https://x.com/page' }),
    ])
    expect(processedMarkdown).toBe('Claim [¹](https://x.com/page), next sentence.')
  })

  it('is idempotent — running on already-processed output yields same output', () => {
    const markdown = 'A [source: https://x.com/a].'
    const evidence = [row({ sourceUrl: 'https://x.com/a' })]
    const first = preprocessMemoCitations(markdown, evidence).processedMarkdown
    const second = preprocessMemoCitations(first, evidence).processedMarkdown
    expect(second).toBe(first)
  })

  it('multi-digit citation numbers: 10th unique URL becomes ¹⁰', () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://x.com/${i}`)
    const markdown = urls.map((u, i) => `Claim ${i} [source: ${u}].`).join(' ')
    const evidence = urls.map((u, i) => row({ id: `r${i}`, sourceUrl: u }))
    const { processedMarkdown } = preprocessMemoCitations(markdown, evidence)
    expect(processedMarkdown).toContain('[¹⁰](https://x.com/9)')   // 10th URL appears
    expect(processedMarkdown).toContain('[¹¹](https://x.com/10)')  // 11th URL
  })

  it('skips non-http(s) URLs (regex requires https?://)', () => {
    const markdown = 'Sketchy [source: javascript:alert(1)].'
    const { processedMarkdown } = preprocessMemoCitations(markdown, [])
    // No match — original text preserved verbatim.
    expect(processedMarkdown).toBe(markdown)
  })

  it('groups multiple evidence rows under the same canonical URL', () => {
    const evidence = [
      row({ id: 'a', sourceUrl: 'https://x.com/page', claimText: 'Claim A' }),
      row({ id: 'b', sourceUrl: 'https://x.com/page', claimText: 'Claim B' }),
    ]
    const { bySource } = preprocessMemoCitations('text', evidence)
    expect(bySource.get('https://x.com/page')?.length).toBe(2)
  })

  it('canonicalizes URLs in bySource so case/trailing-slash variants match', () => {
    const evidence = [row({ sourceUrl: 'https://X.com/page/' })]
    const { bySource } = preprocessMemoCitations('text', evidence)
    expect(bySource.has('https://x.com/page')).toBe(true)
  })
})
