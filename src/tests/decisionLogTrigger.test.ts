/**
 * Tests for renderer/utils/decisionLogTrigger.ts
 *
 * Pure logic, no mocks needed.
 */

import { describe, it, expect } from 'vitest'
import {
  shouldPromptDecisionLog,
  defaultDecisionType
} from '../renderer/utils/decisionLogTrigger'

describe('shouldPromptDecisionLog', () => {
  // Trigger: stage → 'documentation'
  it('returns true when stage changes to documentation', () => {
    expect(shouldPromptDecisionLog('diligence', 'documentation', 'prospect', 'prospect')).toBe(true)
  })

  // Trigger: stage → 'pass'
  it('returns true when stage changes to pass', () => {
    expect(shouldPromptDecisionLog('diligence', 'pass', 'prospect', 'prospect')).toBe(true)
  })

  // Trigger: entityType → 'portfolio'
  it('returns true when entityType changes to portfolio', () => {
    expect(shouldPromptDecisionLog(null, null, 'prospect', 'portfolio')).toBe(true)
  })

  // No trigger: same stage update
  it('returns false when stage stays the same (documentation → documentation)', () => {
    expect(shouldPromptDecisionLog('documentation', 'documentation', 'portfolio', 'portfolio')).toBe(false)
  })

  // No trigger: entityType already portfolio
  it('returns false when entityType was already portfolio', () => {
    expect(shouldPromptDecisionLog(null, null, 'portfolio', 'portfolio')).toBe(false)
  })

  // No trigger: non-trigger stage change
  it('returns false for screening → diligence', () => {
    expect(shouldPromptDecisionLog('screening', 'diligence', 'prospect', 'prospect')).toBe(false)
  })

  // No trigger: null new stage, no entity change
  it('returns false when newStage is null and entityType unchanged', () => {
    expect(shouldPromptDecisionLog('diligence', null, 'prospect', 'prospect')).toBe(false)
  })

  // Combined: stage trigger takes priority alongside entityType change
  it('returns true when both stage and entityType trigger conditions met', () => {
    expect(shouldPromptDecisionLog('diligence', 'documentation', 'prospect', 'portfolio')).toBe(true)
  })
})

describe('defaultDecisionType', () => {
  it('returns Pass for stage=pass', () => {
    expect(defaultDecisionType('pass', 'prospect')).toBe('Pass')
  })

  it('returns Investment Approved for stage=documentation', () => {
    expect(defaultDecisionType('documentation', 'prospect')).toBe('Investment Approved')
  })

  it('returns Investment Approved for entityType=portfolio with no stage', () => {
    expect(defaultDecisionType(null, 'portfolio')).toBe('Investment Approved')
  })

  it('returns Other for unrecognized stage and entity', () => {
    expect(defaultDecisionType('screening', 'prospect')).toBe('Other')
  })

  it('returns Other when both stage and entityType are non-triggering', () => {
    expect(defaultDecisionType(null, 'unknown')).toBe('Other')
  })
})
