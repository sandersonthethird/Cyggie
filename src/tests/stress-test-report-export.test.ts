/**
 * Tests for the StressTestReport → Markdown serializer.
 *
 * Pure-function tests. The serializer is the only user-facing transformation
 * in the stress-test export flow — if it regresses, exports become unreadable
 * without the rest of the UI noticing.
 */

import { describe, it, expect } from 'vitest'
import { serializeStressTestReportToMarkdown } from '../renderer/lib/stress-test-report-export'
import type { StressTestReport } from '../shared/types/stress-test-report'
import type { EvidenceRow } from '../shared/types/thesis'

function makeReport(overrides: Partial<StressTestReport> = {}): StressTestReport {
  return {
    id: 'r-1',
    memoId: 'm-1',
    runId: 'run-1',
    priorMemoVersionId: 'v-1',
    summary: 'Acme has product-market fit signal but burn is high.',
    recommendation: 'proceed_with_caveats',
    concerns: [
      {
        n: 1,
        claim: 'Burn rate exceeds revenue growth',
        evidence: 'Q3 burn $2M vs $400k MRR',
        whatWouldChangeMind: 'A 3-month MRR doubling',
        severity: 'high',
      },
      {
        n: 2,
        claim: 'Single-customer concentration risk',
        evidence: 'Top customer = 40% of revenue',
        whatWouldChangeMind: 'Diversification to top-5 < 60%',
        severity: 'medium',
      },
    ],
    evidence: [],
    costEstimateUsd: 0.42,
    durationMs: 18_500,
    toolCallCount: 12,
    createdAt: '2026-05-15T20:00:00.000Z',
    createdBy: 'user-1',
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    claimText: 'Revenue is growing 30% MoM',
    sourceType: 'meeting',
    sourceId: 'mtg-1',
    sourceUrl: null,
    snippet: 'Founder confirmed in call',
    confidence: 'medium',
    isCritique: false,
    ...overrides,
  } as EvidenceRow
}

describe('serializeStressTestReportToMarkdown', () => {
  it('happy path: contains all expected sections in order', () => {
    const out = serializeStressTestReportToMarkdown(makeReport())
    const titleIdx = out.indexOf('# Stress-test report')
    const summaryIdx = out.indexOf('## Summary')
    const concernsIdx = out.indexOf('## Concerns')
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    expect(summaryIdx).toBeGreaterThan(titleIdx)
    expect(concernsIdx).toBeGreaterThan(summaryIdx)
  })

  it('includes recommendation, cost, duration, tool calls in the header', () => {
    const out = serializeStressTestReportToMarkdown(makeReport())
    expect(out).toContain('**Recommendation:** Proceed with caveats')
    expect(out).toContain('**Cost:** $0.42')
    expect(out).toContain('**Duration:** 18.5s')
    expect(out).toContain('**Tool calls:** 12')
  })

  it('renders concerns numbered with severity + evidence + change-my-mind', () => {
    const out = serializeStressTestReportToMarkdown(makeReport())
    expect(out).toContain('### 1. Burn rate exceeds revenue growth')
    expect(out).toContain('**Severity:** High')
    expect(out).toContain('**Evidence:** Q3 burn $2M vs $400k MRR')
    expect(out).toContain('**What would change my mind:** A 3-month MRR doubling')
    expect(out).toContain('### 2. Single-customer concentration risk')
  })

  it('omits the Concerns section when concerns array is empty', () => {
    const out = serializeStressTestReportToMarkdown(makeReport({ concerns: [] }))
    expect(out).not.toContain('## Concerns')
    expect(out).toContain('## Summary')
  })

  it('renders claim-level flags only for isCritique=true evidence', () => {
    const out = serializeStressTestReportToMarkdown(
      makeReport({
        evidence: [
          makeEvidence({ claimText: 'Critique A', isCritique: true, severity: 'high' }),
          makeEvidence({ claimText: 'Support B', isCritique: false }),
        ],
      }),
    )
    expect(out).toContain('## Claim-level flags (1)')
    expect(out).toContain('Critique A')
    expect(out).toContain('(High)')
    expect(out).toContain('## Supporting evidence (1)')
    expect(out).toContain('Support B')
  })

  it('omits Claim-level flags + Supporting sections when evidence is empty', () => {
    const out = serializeStressTestReportToMarkdown(makeReport({ evidence: [] }))
    expect(out).not.toContain('## Claim-level flags')
    expect(out).not.toContain('## Supporting evidence')
  })

  it('preserves special characters in claim text (no escape regressions)', () => {
    const out = serializeStressTestReportToMarkdown(
      makeReport({
        concerns: [
          {
            n: 1,
            claim: 'Revenue model uses *aggressive* discounts & 50% margins',
            evidence: 'Slide 7 — note the < 12-month payback',
            whatWouldChangeMind: 'A real cohort analysis',
            severity: 'medium',
          },
        ],
      }),
    )
    expect(out).toContain('*aggressive*')
    expect(out).toContain('&')
    expect(out).toContain('<')
    expect(out).toContain('50%')
  })

  it('ends with a single trailing newline', () => {
    const out = serializeStressTestReportToMarkdown(makeReport())
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })
})
