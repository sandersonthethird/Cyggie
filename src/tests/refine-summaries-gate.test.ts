/**
 * Tests the default-on gate for the second "refine/condense" summary pass.
 *
 * The pass is opt-OUT: it runs unless the `refineSummaries` setting is the
 * explicit string 'false'. A never-written setting (null) keeps it on.
 */

import { describe, it, expect } from 'vitest'
import { shouldRefineSummaries } from '@cyggie/services/llm/critique'

describe('shouldRefineSummaries (refineSummaries gate)', () => {
  it('defaults ON when the setting was never written (null)', () => {
    expect(shouldRefineSummaries(null)).toBe(true)
  })

  it('is ON when explicitly "true"', () => {
    expect(shouldRefineSummaries('true')).toBe(true)
  })

  it('is OFF only for the explicit string "false"', () => {
    expect(shouldRefineSummaries('false')).toBe(false)
  })

  it('stays ON for unexpected/garbage values (fail-safe to refining)', () => {
    expect(shouldRefineSummaries('')).toBe(true)
    expect(shouldRefineSummaries('0')).toBe(true)
  })
})
