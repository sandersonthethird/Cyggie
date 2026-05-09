/**
 * Tests for resolveDedupKeep.
 *
 * Regression context: a bug in the dedup conflict-count effect inlined the
 * keep-resolution logic differently than the UI dropdown / Review button,
 * causing the "Review (N conflicts)" indicator to disagree with the modal
 * that opened. The four call sites now share this helper. These tests pin
 * the contract so that contract can't drift again.
 */

import { describe, it, expect } from 'vitest'
import { resolveDedupKeep } from '../renderer/utils/dedupKeep'
import type { CompanyDuplicateGroup } from '../shared/types/company'

function makeGroup(
  ids: string[],
  suggestedKeepCompanyId = ids[0]
): CompanyDuplicateGroup {
  return {
    key: 'g1',
    domain: null,
    reason: 'test',
    suggestedKeepCompanyId,
    companies: ids.map((id) => ({
      id,
      canonicalName: id,
      primaryDomain: null,
      websiteUrl: null,
      entityType: 'unknown',
      pipelineStage: null,
      updatedAt: '2026-01-01',
      populatedFieldCount: 0,
      meetingCount: 0,
      emailCount: 0,
      noteCount: 0
    }))
  }
}

describe('resolveDedupKeep', () => {
  it('returns the user preference when it is in the selected set', () => {
    const group = makeGroup(['a', 'b', 'c'], 'a')
    expect(resolveDedupKeep(group, ['b', 'c'], 'b')).toBe('b')
  })

  it('falls back to the first selected id when preference is not in selected', () => {
    // Reproduces the original bug: user deselected the suggested keeper
    // and the conflict effect was using the stale preference (a) anyway.
    const group = makeGroup(['a', 'b', 'c'], 'a')
    expect(resolveDedupKeep(group, ['b', 'c'], 'a')).toBe('b')
  })

  it('falls back to the suggested keeper when nothing is selected', () => {
    const group = makeGroup(['a', 'b', 'c'], 'a')
    expect(resolveDedupKeep(group, [], 'a')).toBe('a')
  })

  it('falls back to the suggested keeper when preference is undefined and nothing is selected', () => {
    const group = makeGroup(['a', 'b', 'c'], 'b')
    expect(resolveDedupKeep(group, [], undefined)).toBe('b')
  })

  it('uses selected[0] over the suggested keeper when both differ', () => {
    const group = makeGroup(['a', 'b', 'c'], 'a')
    // Suggestion (a) isn't in selection; preference (a) also not in selection;
    // first selected wins.
    expect(resolveDedupKeep(group, ['c', 'b'], 'a')).toBe('c')
  })

  it('respects preference equal to suggested keeper when both are in selection', () => {
    const group = makeGroup(['a', 'b'], 'a')
    expect(resolveDedupKeep(group, ['a', 'b'], 'a')).toBe('a')
  })
})
