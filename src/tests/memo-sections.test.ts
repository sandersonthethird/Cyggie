import { describe, it, expect } from 'vitest'
import {
  MEMO_SECTIONS,
  isSeriesAOrLater,
  normalizeLegacyHeadings,
  replaceSectionInMarkdown,
  canonicalizeUrl,
  isMemoSectionHeading,
  getSection,
} from '../main/llm/memo/sections'

describe('MEMO_SECTIONS roster', () => {
  it('has 11 sections', () => {
    expect(MEMO_SECTIONS.length).toBe(11)
  })

  it('ordinals are sequential starting at 1', () => {
    const ordinals = MEMO_SECTIONS.map((s) => s.ordinal)
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('Executive Summary is required and synthesis', () => {
    const s = getSection('Executive Summary')!
    expect(s.required).toBe(true)
    expect(s.kind).toBe('synthesis')
    expect(s.gate).toBe(null)
  })

  it('Investment Thesis is optional with has_substantive_thesis gate', () => {
    const s = getSection('Investment Thesis')!
    expect(s.required).toBe(false)
    expect(s.gate).toBe('has_substantive_thesis')
  })

  it('Valuation is gated by series_a_plus', () => {
    const s = getSection('Valuation')!
    expect(s.gate).toBe('series_a_plus')
    expect(s.required).toBe(false)
  })

  it('References gate is has_reference_calls', () => {
    expect(getSection('References')!.gate).toBe('has_reference_calls')
  })

  it('does NOT contain the legacy "Investment Highlights" heading', () => {
    expect(getSection('Investment Highlights')).toBeUndefined()
  })
})

describe('isMemoSectionHeading', () => {
  it('returns true for known headings', () => {
    expect(isMemoSectionHeading('Executive Summary')).toBe(true)
    expect(isMemoSectionHeading('Investment Thesis')).toBe(true)
    expect(isMemoSectionHeading('Valuation')).toBe(true)
  })
  it('returns false for the legacy name', () => {
    expect(isMemoSectionHeading('Investment Highlights')).toBe(false)
  })
  it('returns false for garbage', () => {
    expect(isMemoSectionHeading('Anything')).toBe(false)
    expect(isMemoSectionHeading('')).toBe(false)
  })
})

describe('isSeriesAOrLater', () => {
  const cases: Array<[string | null | undefined, boolean]> = [
    [null, false],
    [undefined, false],
    ['', false],
    ['Pre-Seed', false],
    ['pre-seed', false],
    ['Seed', false],
    ['Seed+', false],
    ['Angel', false],
    ['Series A bridge', false],     // documented limitation: "bridge" rounds excluded
    ['Series A', true],
    ['series a', true],
    [' Series A ', true],
    ['Series B', true],
    ['Series C', true],
    ['Series F', true],
    ['Growth', true],
    ['growth', true],
    ['Late Stage', true],
    ['Late-stage', true],
    ['Pre-IPO', true],
    ['Pre IPO', true],
    ['garbage', false],
  ]
  for (const [input, expected] of cases) {
    it(`returns ${expected} for ${JSON.stringify(input)}`, () => {
      expect(isSeriesAOrLater(input)).toBe(expected)
    })
  }
})

describe('normalizeLegacyHeadings', () => {
  it('rewrites "## Investment Highlights" to "## Investment Thesis"', () => {
    const input = '# Memo\n\n## Investment Highlights\n- bullet\n\n## Risks\n'
    const out = normalizeLegacyHeadings(input)
    expect(out).toContain('## Investment Thesis')
    expect(out).not.toContain('## Investment Highlights')
  })

  it('is idempotent', () => {
    const input = '## Investment Highlights\nbody'
    const once = normalizeLegacyHeadings(input)
    const twice = normalizeLegacyHeadings(once)
    expect(once).toBe(twice)
  })

  it('does NOT rewrite the phrase appearing in body text', () => {
    const input =
      '# Memo\n\n## Executive Summary\nThe Investment Highlights section below covers...\n\n## Investment Highlights\n- bullet\n'
    const out = normalizeLegacyHeadings(input)
    // The body-text reference is preserved verbatim
    expect(out).toContain('The Investment Highlights section below')
    // The actual heading IS rewritten
    expect(out).toContain('## Investment Thesis\n- bullet')
  })

  it('leaves modern memos unchanged', () => {
    const input = '# Memo\n\n## Investment Thesis\n- bullet\n\n## Risks\n- risk\n'
    expect(normalizeLegacyHeadings(input)).toBe(input)
  })
})

describe('replaceSectionInMarkdown', () => {
  const memo = [
    '# Company A — Investment Memo',
    '',
    '## Executive Summary',
    'Recommend pass.',
    '',
    '## Competition',
    'Old competition body.',
    'More old content.',
    '',
    '## Team',
    'Founders are great.',
    '',
  ].join('\n')

  it('replaces the named section body', () => {
    const out = replaceSectionInMarkdown(memo, 'Competition', 'New competition body.')
    expect(out).toContain('## Competition\nNew competition body.')
    expect(out).not.toContain('Old competition body')
  })

  it('leaves other sections byte-identical', () => {
    const out = replaceSectionInMarkdown(memo, 'Competition', 'New body.')
    expect(out).toContain('## Executive Summary\nRecommend pass.')
    expect(out).toContain('## Team\nFounders are great.')
  })

  it('replaces a trailing section (last in document)', () => {
    const out = replaceSectionInMarkdown(memo, 'Team', 'Different team body.')
    expect(out).toMatch(/## Team\nDifferent team body\.\s*$/)
  })

  it('throws when heading is not present', () => {
    expect(() => replaceSectionInMarkdown(memo, 'Nonexistent', 'foo')).toThrow(/not found/)
  })

  it('preserves the title line', () => {
    const out = replaceSectionInMarkdown(memo, 'Competition', 'x')
    expect(out.startsWith('# Company A — Investment Memo')).toBe(true)
  })

  it('escapes regex-special chars in the heading', () => {
    const tricky = '## Traction / Financials\nold\n\n## Risks\nx\n'
    const out = replaceSectionInMarkdown(tricky, 'Traction / Financials', 'new')
    expect(out).toContain('## Traction / Financials\nnew')
    expect(out).toContain('## Risks\nx')
  })
})

describe('canonicalizeUrl', () => {
  it('lowercases the host', () => {
    expect(canonicalizeUrl('https://Example.COM/Path')).toBe('https://example.com/Path')
  })

  it('strips default ports', () => {
    expect(canonicalizeUrl('https://example.com:443/x')).toBe('https://example.com/x')
    expect(canonicalizeUrl('http://example.com:80/x')).toBe('http://example.com/x')
  })

  it('preserves non-default ports', () => {
    expect(canonicalizeUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x')
  })

  it('strips a trailing slash but not the root slash', () => {
    expect(canonicalizeUrl('https://example.com/path/')).toBe('https://example.com/path')
    expect(canonicalizeUrl('https://example.com/')).toBe('https://example.com/')
  })

  it('returns null for malformed URLs', () => {
    expect(canonicalizeUrl('not-a-url')).toBe(null)
    expect(canonicalizeUrl('')).toBe(null)
  })

  it('returns null for non-http(s) protocols', () => {
    expect(canonicalizeUrl('file:///etc/passwd')).toBe(null)
    expect(canonicalizeUrl('javascript:alert(1)')).toBe(null)
  })

  it('preserves path case', () => {
    expect(canonicalizeUrl('https://example.com/CamelCase')).toBe('https://example.com/CamelCase')
  })
})

