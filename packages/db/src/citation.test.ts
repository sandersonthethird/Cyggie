import { describe, it, expect } from 'vitest'
import { extractCitations, type Citation } from './citation'

const co = (id: string, label: string): Citation => ({ type: 'company', id, label })
const mtg = (id: string, label: string): Citation => ({ type: 'meeting', id, label })

describe('extractCitations (2A conservative matcher)', () => {
  it('cites a candidate whose label appears as a whole word', () => {
    const out = extractCitations('Acme Corp looks like a strong fit.', [co('c1', 'Acme Corp')])
    expect(out).toEqual([co('c1', 'Acme Corp')])
  })

  it('does NOT cite on a partial/substring match (word boundaries)', () => {
    // "Acme" must not match inside "Acmevale".
    expect(extractCitations('Acmevale is unrelated.', [co('c1', 'Acme')])).toEqual([])
  })

  it('is case- and whitespace-insensitive', () => {
    const out = extractCitations('we discussed   ACME   corp today', [co('c1', 'Acme Corp')])
    expect(out).toEqual([co('c1', 'Acme Corp')])
  })

  it('skips labels shorter than the min length (AI / Inc / Co noise)', () => {
    expect(extractCitations('This AI is great, Inc.', [co('c1', 'AI'), co('c2', 'Inc')])).toEqual([])
  })

  it('dedupes by type:id', () => {
    const out = extractCitations('Acme Acme Acme', [co('c1', 'Acme Corp')])
    // label is "Acme Corp" — appears once; ensure single entry even if repeated text
    expect(extractCitations('Acme Corp and Acme Corp again', [co('c1', 'Acme Corp')])).toEqual([co('c1', 'Acme Corp')])
    expect(out).toEqual([]) // "Acme Corp" not present as a whole phrase in "Acme Acme Acme"
  })

  it('caps at 5 citations', () => {
    const many = Array.from({ length: 8 }, (_, i) => co(`c${i}`, `Company Number ${i}`))
    const answer = many.map((c) => c.label).join(', ')
    expect(extractCitations(answer, many)).toHaveLength(5)
  })

  it('preserves candidate order', () => {
    const out = extractCitations('Beta Industries then Alpha Holdings', [
      co('a', 'Alpha Holdings'),
      co('b', 'Beta Industries'),
    ])
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('matches different entity types', () => {
    const out = extractCitations('In the Q3 Planning Sync we agreed with Globex Systems.', [
      mtg('m1', 'Q3 Planning Sync'),
      co('c1', 'Globex Systems'),
    ])
    expect(out.map((c) => c.id).sort()).toEqual(['c1', 'm1'])
  })

  it('handles nil/empty inputs without throwing', () => {
    expect(extractCitations(null, [co('c1', 'Acme')])).toEqual([])
    expect(extractCitations('', [co('c1', 'Acme')])).toEqual([])
    expect(extractCitations('hello', null)).toEqual([])
    expect(extractCitations('hello', [])).toEqual([])
  })

  it('handles regex-special characters in labels safely', () => {
    const out = extractCitations('We met C++ Builders (Pty).', [co('c1', 'C++ Builders')])
    expect(out).toEqual([co('c1', 'C++ Builders')])
  })
})
