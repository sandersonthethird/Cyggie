import { describe, expect, it } from 'vitest'
import { estimateAgentRunCostUsd } from './cost-estimate'

const SONNET = 'claude-sonnet-4-5-20250929'
const HAIKU = 'claude-haiku-4-5-20251001'

// Default caps surfaced in Settings → Investment Thesis Agent.
const DEFAULTS = { inputTokens: 400_000, iterations: 15, webSearches: 5 }

describe('estimateAgentRunCostUsd', () => {
  it('matches the expected value at Sonnet defaults', () => {
    // 400k*3/1e6 + 15*700*15/1e6 + 5*0.01 = 1.20 + 0.1575 + 0.05
    expect(estimateAgentRunCostUsd(DEFAULTS, SONNET)).toBeCloseTo(1.4075, 4)
  })

  it('matches the expected value at Haiku defaults', () => {
    // 400k*1/1e6 + 15*700*5/1e6 + 5*0.01 = 0.40 + 0.0525 + 0.05
    expect(estimateAgentRunCostUsd(DEFAULTS, HAIKU)).toBeCloseTo(0.5025, 4)
  })

  it('prices Haiku cheaper than Sonnet for identical caps', () => {
    expect(estimateAgentRunCostUsd(DEFAULTS, HAIKU)).toBeLessThan(
      estimateAgentRunCostUsd(DEFAULTS, SONNET),
    )
  })

  it('increases monotonically as each cap rises', () => {
    const base = estimateAgentRunCostUsd(DEFAULTS, SONNET)
    expect(estimateAgentRunCostUsd({ ...DEFAULTS, inputTokens: 800_000 }, SONNET)).toBeGreaterThan(base)
    expect(estimateAgentRunCostUsd({ ...DEFAULTS, iterations: 30 }, SONNET)).toBeGreaterThan(base)
    expect(estimateAgentRunCostUsd({ ...DEFAULTS, webSearches: 20 }, SONNET)).toBeGreaterThan(base)
  })

  it('treats a NaN/empty cap as 0 instead of producing NaN', () => {
    // Mirrors a field cleared mid-edit (Number('') === NaN).
    const cost = estimateAgentRunCostUsd(
      { inputTokens: NaN, iterations: 15, webSearches: 5 },
      SONNET,
    )
    expect(Number.isNaN(cost)).toBe(false)
    // input term drops out; only output + search remain.
    expect(cost).toBeCloseTo(0.1575 + 0.05, 4)
  })

  it('falls back to default (Sonnet) pricing for an unknown model id', () => {
    expect(estimateAgentRunCostUsd(DEFAULTS, 'gpt-4o')).toBeCloseTo(
      estimateAgentRunCostUsd(DEFAULTS, SONNET),
      4,
    )
  })
})
