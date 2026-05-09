import { describe, it, expect } from 'vitest'
import { scopeLockCheck } from '../main/llm/agents/thesis-stress-test-agent'

const ORIGINAL = `# Acme — Series A — $5M

## Executive Summary
Acme is a fintech startup. We recommend proceeding to a partner meeting.

## Investment Highlights
- Strong founder
- Big TAM

## Business Description
Acme builds invoicing software for SMBs.

## Market / Industry
The SMB invoicing market is large.

## Competition
- QuickBooks
- FreshBooks

## Team
- Jane Doe, CEO
- John Smith, CTO

## Traction / Financials
$1M ARR, 200% NRR.

## Go-To-Market
Inbound + content marketing.

## Valuation
$25M post-money.

## Risks
- Compete with QuickBooks

## References
- John Doe, BigCo CFO
`

const STRESS_TESTED_OK = `# Acme — Series A — $5M

## Executive Summary
Acme is a fintech startup. We recommend passing — see Devil's Advocate.

## Investment Highlights
- Strong founder, but TAM may be inflated (see Devil's Advocate #1)
- Top-quartile growth

## Business Description
Acme builds invoicing software for SMBs.

## Market / Industry
The SMB invoicing market is large.

## Competition
- QuickBooks
- FreshBooks
- Wave (added)
- Bill.com (added)

## Team
- Jane Doe, CEO
- John Smith, CTO

## Traction / Financials
$1M ARR, 200% NRR — verified via [source: pitch deck].

## Go-To-Market
Inbound + content marketing.

## Valuation
$25M post-money. Comparable to FreshBooks at similar stage.

## Risks
- Compete with QuickBooks
- Stripe entering the SMB invoicing space (added)

## References
- John Doe, BigCo CFO

## Devil's Advocate
1. **Claim**: 200% NRR. **Evidence weakening it**: only 1 data point...
`

const STRESS_TESTED_TAMPERED = ORIGINAL.replace(
  '## Team\n- Jane Doe, CEO',
  '## Team\n- Jane Doe, CEO (former Stripe employee)',
) + '\n## Devil\'s Advocate\n1. concern\n'

describe('scopeLockCheck', () => {
  it('returns no warnings when descriptive sections are byte-identical', () => {
    const warnings = scopeLockCheck(ORIGINAL, STRESS_TESTED_OK)
    expect(warnings).toEqual([])
  })

  it('warns when a descriptive section was modified', () => {
    const warnings = scopeLockCheck(ORIGINAL, STRESS_TESTED_TAMPERED)
    expect(warnings.some(w => w.includes('Team') && w.includes('modified'))).toBe(true)
  })

  it('warns when a descriptive section is missing from output', () => {
    const stripped = STRESS_TESTED_OK
      .split('\n')
      .filter(line => !line.startsWith('## Team') && line !== '- Jane Doe, CEO' && line !== '- John Smith, CTO')
      .join('\n')
    const warnings = scopeLockCheck(ORIGINAL, stripped)
    // The strip is rough; just check that *some* missing/modified Team warning fires
    expect(warnings.some(w => w.includes('Team'))).toBe(true)
  })

  it("warns when the Devil's Advocate appendix is missing", () => {
    const noDevils = STRESS_TESTED_OK.replace(/## Devil's Advocate[\s\S]*$/, '')
    const warnings = scopeLockCheck(ORIGINAL, noDevils)
    expect(warnings.some(w => w.includes("Devil's Advocate"))).toBe(true)
  })

  it('tolerates trailing whitespace differences (normalizes per-line)', () => {
    const trailing = STRESS_TESTED_OK.replace('Acme builds invoicing software for SMBs.', 'Acme builds invoicing software for SMBs.   ')
    expect(scopeLockCheck(ORIGINAL, trailing)).toEqual([])
  })

  it('tolerates extra blank lines between sections', () => {
    const extraBlanks = STRESS_TESTED_OK.replace('Acme builds invoicing software for SMBs.\n\n## Market', 'Acme builds invoicing software for SMBs.\n\n\n\n## Market')
    expect(scopeLockCheck(ORIGINAL, extraBlanks)).toEqual([])
  })

  it('does not warn about target-section edits (those ARE allowed)', () => {
    const warnings = scopeLockCheck(ORIGINAL, STRESS_TESTED_OK)
    // Target sections were edited (Exec Summary, Highlights, Competition, Traction,
    // Valuation, Risks); none of these should produce warnings.
    expect(warnings.find(w => w.includes('Investment Highlights'))).toBeUndefined()
    expect(warnings.find(w => w.includes('Competition'))).toBeUndefined()
    expect(warnings.find(w => w.includes('Risks'))).toBeUndefined()
  })
})
