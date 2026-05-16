/**
 * Serialize a StressTestReport to markdown for copy/paste sharing.
 *
 *   ┌──────────────────┐
 *   │  Stress Test     │
 *   │  Report          │
 *   ├──────────────────┤
 *   │  - Recommendation│
 *   │  - Cost/duration │
 *   │  - Summary       │
 *   │  - Concerns []   │
 *   │  - Claim flags   │
 *   │  - Supporting ev │
 *   └──────────────────┘
 *
 * Pure function: no DOM, no IPC, easy to unit-test.
 */

import type { StressTestReport, Recommendation, Severity } from '../../shared/types/stress-test-report'
import type { EvidenceRow } from '../../shared/types/thesis'

const REC_LABEL: Record<Recommendation, string> = {
  proceed: 'Proceed',
  proceed_with_caveats: 'Proceed with caveats',
  pass: 'Pass',
  dig_deeper: 'Dig deeper',
}

const SEV_LABEL: Record<Severity, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export function serializeStressTestReportToMarkdown(report: StressTestReport): string {
  const lines: string[] = []

  lines.push(`# Stress-test report`)
  lines.push('')
  lines.push(`**Recommendation:** ${REC_LABEL[report.recommendation] ?? report.recommendation}`)
  lines.push(`**Run at:** ${report.createdAt}`)
  lines.push(`**Cost:** $${report.costEstimateUsd.toFixed(2)}`)
  lines.push(`**Duration:** ${(report.durationMs / 1000).toFixed(1)}s`)
  lines.push(`**Tool calls:** ${report.toolCallCount}`)
  lines.push('')
  lines.push(`## Summary`)
  lines.push('')
  lines.push(report.summary.trim())
  lines.push('')

  if (report.concerns.length > 0) {
    lines.push(`## Concerns (${report.concerns.length})`)
    lines.push('')
    for (const c of report.concerns) {
      lines.push(`### ${c.n}. ${c.claim}`)
      lines.push(`**Severity:** ${SEV_LABEL[c.severity] ?? c.severity}`)
      lines.push('')
      lines.push(`**Evidence:** ${c.evidence}`)
      lines.push('')
      lines.push(`**What would change my mind:** ${c.whatWouldChangeMind}`)
      lines.push('')
    }
  }

  const critiques = report.evidence.filter(e => e.isCritique)
  const supporting = report.evidence.filter(e => !e.isCritique)

  if (critiques.length > 0) {
    lines.push(`## Claim-level flags (${critiques.length})`)
    lines.push('')
    for (const ev of critiques) {
      lines.push(formatEvidenceLine(ev, true))
    }
    lines.push('')
  }

  if (supporting.length > 0) {
    lines.push(`## Supporting evidence (${supporting.length})`)
    lines.push('')
    for (const ev of supporting) {
      lines.push(formatEvidenceLine(ev, false))
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

function formatEvidenceLine(ev: EvidenceRow, critique: boolean): string {
  const parts: string[] = [`- **${ev.claimText}**`]
  if (critique && ev.severity) parts.push(`(${SEV_LABEL[ev.severity] ?? ev.severity})`)
  if (ev.snippet) parts.push(`— ${ev.snippet}`)
  if (ev.sourceUrl) parts.push(`[source](${ev.sourceUrl})`)
  return parts.join(' ')
}
