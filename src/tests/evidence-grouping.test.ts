import { describe, it, expect } from 'vitest'
import { groupEvidenceBySection } from '../renderer/components/company/MemoSectionsNav'
import type { StoredMemoEvidence } from '../shared/types/memo-evidence'

function row(overrides: Partial<StoredMemoEvidence> = {}): StoredMemoEvidence {
  return {
    id: overrides.id ?? `ev-${Math.random()}`,
    versionId: 'v-1',
    claimText: overrides.claimText ?? 'claim',
    claimCategory: null,
    sourceType: overrides.sourceType ?? 'web',
    sourceId: null,
    sourceUrl: overrides.sourceUrl ?? 'https://x.com/a',
    snippet: 'snippet',
    confidence: 'high',
    severity: null,
    isCritique: false,
    section: overrides.section ?? null,
    createdAt: '2025-01-01',
  }
}

describe('groupEvidenceBySection', () => {
  it('groups rows by their section field', () => {
    const rows = [
      row({ id: '1', section: 'Market / Industry' }),
      row({ id: '2', section: 'Market / Industry' }),
      row({ id: '3', section: 'Risks' }),
    ]
    const groups = groupEvidenceBySection(rows)
    expect(groups.get('Market / Industry')?.length).toBe(2)
    expect(groups.get('Risks')?.length).toBe(1)
  })

  it('drops rows with section === null (legacy memos)', () => {
    const rows = [
      row({ id: '1', section: 'Market / Industry' }),
      row({ id: '2', section: null }),
      row({ id: '3', section: null }),
    ]
    const groups = groupEvidenceBySection(rows)
    expect(groups.size).toBe(1)
    expect(groups.get('Market / Industry')?.length).toBe(1)
  })

  it('preserves insertion order within a group', () => {
    const rows = [
      row({ id: 'a', section: 'Risks', claimText: 'first' }),
      row({ id: 'b', section: 'Risks', claimText: 'second' }),
      row({ id: 'c', section: 'Risks', claimText: 'third' }),
    ]
    const groups = groupEvidenceBySection(rows)
    const risks = groups.get('Risks')!
    expect(risks.map(r => r.claimText)).toEqual(['first', 'second', 'third'])
  })

  it('returns an empty Map for an empty evidence array', () => {
    const groups = groupEvidenceBySection([])
    expect(groups.size).toBe(0)
  })

  it('returns an empty Map when all rows have null section', () => {
    const rows = [row({ section: null }), row({ section: null })]
    const groups = groupEvidenceBySection(rows)
    expect(groups.size).toBe(0)
  })

  it('treats empty-string section as falsy and drops the row', () => {
    const rows = [row({ section: '' }), row({ section: 'Risks' })]
    const groups = groupEvidenceBySection(rows)
    // Empty-string section is falsy in JS; the grouping helper treats it
    // identically to null. Documenting current behavior; if producers ever
    // emit '' as a real section name (they shouldn't), this would need
    // adjusting.
    expect(groups.size).toBe(1)
    expect(groups.get('Risks')?.length).toBe(1)
  })
})
