import { describe, it, expect } from 'vitest'
import {
  SubmitReviewInputSchema,
  ConcernSchema,
  RecommendationSchema,
} from '../shared/types/stress-test-report'

const validConcern = {
  n: 1,
  claim: 'TAM is $50B by 2027',
  evidence: 'Gartner 2024 report projects $12B; analyst overstated by 4x',
  whatWouldChangeMind: 'A 2024+ primary source projecting $40B+ would help',
  severity: 'medium' as const,
}

function makeValid(overrides: Partial<Parameters<typeof SubmitReviewInputSchema.parse>[0]> = {}) {
  return {
    summary: 'Of 11 core claims, 3 are weakly sourced. Recommend caveats.',
    recommendation: 'proceed_with_caveats' as const,
    concerns: [validConcern, { ...validConcern, n: 2 }, { ...validConcern, n: 3 }],
    evidence: [],
    ...overrides,
  }
}

describe('SubmitReviewInputSchema', () => {
  it('accepts a well-formed report', () => {
    const r = SubmitReviewInputSchema.safeParse(makeValid())
    expect(r.success).toBe(true)
  })

  it('rejects fewer than 3 concerns', () => {
    const r = SubmitReviewInputSchema.safeParse(makeValid({ concerns: [validConcern, { ...validConcern, n: 2 }] }))
    expect(r.success).toBe(false)
  })

  it('rejects more than 8 concerns', () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...validConcern, n: i + 1 }))
    const r = SubmitReviewInputSchema.safeParse(makeValid({ concerns: nine }))
    expect(r.success).toBe(false)
  })

  it('rejects a recommendation outside the enum', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = SubmitReviewInputSchema.safeParse(makeValid({ recommendation: 'maybe' as any }))
    expect(r.success).toBe(false)
  })

  it('rejects summary shorter than 20 chars', () => {
    const r = SubmitReviewInputSchema.safeParse(makeValid({ summary: 'too short' }))
    expect(r.success).toBe(false)
  })

  it('defaults severity to medium when omitted', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = ConcernSchema.parse({ ...validConcern, severity: undefined as any })
    expect(r.severity).toBe('medium')
  })

  it('rejects concern with claim < 10 chars', () => {
    const r = SubmitReviewInputSchema.safeParse(makeValid({
      concerns: [{ ...validConcern, claim: 'short' }, { ...validConcern, n: 2 }, { ...validConcern, n: 3 }],
    }))
    expect(r.success).toBe(false)
  })

  it('accepts web evidence with sourceUrl', () => {
    const r = SubmitReviewInputSchema.safeParse(makeValid({
      evidence: [{
        claimText: 'TAM check',
        sourceType: 'web',
        sourceUrl: 'https://gartner.com/x',
        snippet: 'Gartner projects $12B',
        confidence: 'high',
        isCritique: true,
        severity: 'high',
      }],
    }))
    expect(r.success).toBe(true)
  })

  it('rejects web evidence without sourceUrl (reuses EvidenceRow refinement)', () => {
    const r = SubmitReviewInputSchema.safeParse(makeValid({
      evidence: [{
        claimText: 'TAM check',
        sourceType: 'web',
        snippet: 'no url',
        confidence: 'high',
        isCritique: true,
      }],
    }))
    expect(r.success).toBe(false)
  })
})

describe('RecommendationSchema', () => {
  it('accepts all four values', () => {
    for (const v of ['proceed', 'proceed_with_caveats', 'pass', 'dig_deeper'] as const) {
      expect(RecommendationSchema.safeParse(v).success).toBe(true)
    }
  })
})
