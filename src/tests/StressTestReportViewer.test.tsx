// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import type { StressTestReport } from '../shared/types/stress-test-report'

vi.mock('../renderer/components/company/StressTestReportViewer.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

const { StressTestReportViewer } = await import(
  '../renderer/components/company/StressTestReportViewer'
)

afterEach(() => cleanup())

function makeReport(overrides: Partial<StressTestReport> = {}): StressTestReport {
  return {
    id: 'rep-1',
    memoId: 'memo-1',
    runId: 'run-1',
    priorMemoVersionId: 'v-14',
    summary: 'Of 11 claims reviewed, 3 are weakly sourced. Recommend caveats.',
    recommendation: 'proceed_with_caveats',
    concerns: [
      { n: 1, claim: 'TAM is $50B by 2027', evidence: 'Gartner says $12B', whatWouldChangeMind: 'A 2024+ primary source', severity: 'high' },
      { n: 2, claim: 'Founder has prior exit', evidence: 'No record in Crunchbase', whatWouldChangeMind: 'Direct confirmation', severity: 'medium' },
      { n: 3, claim: 'CAC < 6mo', evidence: 'Unit econ slide is thin', whatWouldChangeMind: 'Cohort curve', severity: 'low' },
    ],
    evidence: [
      {
        claimText: 'TAM check from Gartner',
        sourceType: 'web',
        sourceUrl: 'https://gartner.com/x',
        snippet: 'Gartner projects $12B by 2027',
        confidence: 'high',
        isCritique: true,
        severity: 'high',
      },
      {
        claimText: 'Pitch deck context',
        sourceType: 'drive_file',
        sourceId: 'file-1',
        snippet: 'Pitch deck context',
        confidence: 'medium',
        isCritique: false,
      },
    ],
    costEstimateUsd: 0.35,
    durationMs: 230_000,
    toolCallCount: 22,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    createdBy: 'u-1',
    ...overrides,
  }
}

describe('StressTestReportViewer', () => {
  it('renders summary, recommendation label, and all concerns', () => {
    const onClose = vi.fn()
    const { getByText, getAllByText } = render(
      <StressTestReportViewer report={makeReport()} onClose={onClose} />,
    )
    expect(getByText(/Of 11 claims reviewed/)).toBeTruthy()
    expect(getByText('Proceed with caveats')).toBeTruthy()
    expect(getByText(/TAM is \$50B/)).toBeTruthy()
    expect(getByText(/Founder has prior exit/)).toBeTruthy()
    expect(getByText(/CAC < 6mo/)).toBeTruthy()
    // Three severity badges (one per concern card; evidence badges separate).
    const sevBadges = getAllByText(/high|medium|low/)
    expect(sevBadges.length).toBeGreaterThanOrEqual(3)
  })

  it('groups evidence into claim-level flags vs supporting context', () => {
    const { getByText } = render(
      <StressTestReportViewer report={makeReport()} onClose={vi.fn()} />,
    )
    expect(getByText(/Claim-level flags \(1\)/)).toBeTruthy()
    expect(getByText(/Supporting evidence \(1\)/)).toBeTruthy()
  })

  it('renders source links with target=_blank rel=noreferrer (security)', () => {
    render(<StressTestReportViewer report={makeReport()} onClose={vi.fn()} />)
    // Viewer mounts via createPortal to document.body — query the document.
    const link = document.body.querySelector('a[href="https://gartner.com/x"]') as HTMLAnchorElement | null
    expect(link).toBeTruthy()
    expect(link!.target).toBe('_blank')
    expect(link!.rel).toContain('noreferrer')
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<StressTestReportViewer report={makeReport()} onClose={onClose} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders the "pass" recommendation differently from "proceed"', () => {
    const { getByText } = render(
      <StressTestReportViewer
        report={makeReport({ recommendation: 'pass' })}
        onClose={vi.fn()}
      />,
    )
    expect(getByText('Pass')).toBeTruthy()
  })
})
