import { z } from 'zod'
import { EvidenceRowSchema } from './thesis'

/**
 * Stress-test Report — output of the stress-test agent under the new product
 * model (memo-untouched). One report per completed stress-test run.
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Schema contract                                                       │
 *   │                                                                       │
 *   │  submit_review (terminal tool) input:                                  │
 *   │   • summary           — bottom-line write-up (20–2000 chars)          │
 *   │   • recommendation    — proceed / proceed_with_caveats / pass /        │
 *   │                          dig_deeper                                    │
 *   │   • concerns[]        — 3–8 numbered counter-arguments (Devil's        │
 *   │                          Advocate content). Each has:                  │
 *   │                            n, claim, evidence, whatWouldChangeMind,    │
 *   │                            severity                                    │
 *   │   • evidence[]        — flat EvidenceRow[] (reuses memo evidence       │
 *   │                          schema). Rows with isCritique=true are        │
 *   │                          claim-level flags; rows without are general   │
 *   │                          context.                                      │
 *   │                                                                       │
 *   │  No critiques[] field: claim-level flags reuse the existing            │
 *   │  EvidenceRow.isCritique=true model. DRY + single source-binding        │
 *   │  refinement.                                                           │
 *   └──────────────────────────────────────────────────────────────────────┘
 */

export const RecommendationSchema = z.enum([
  'proceed',
  'proceed_with_caveats',
  'pass',
  'dig_deeper',
])
export type Recommendation = z.infer<typeof RecommendationSchema>

export const SeveritySchema = z.enum(['low', 'medium', 'high'])
export type Severity = z.infer<typeof SeveritySchema>

export const ConcernSchema = z.object({
  n: z.number().int().min(1),
  claim: z.string().min(10).max(500),
  evidence: z.string().min(10).max(1000),
  whatWouldChangeMind: z.string().min(10).max(500),
  severity: SeveritySchema.default('medium'),
})
export type Concern = z.infer<typeof ConcernSchema>

export const SubmitReviewInputSchema = z.object({
  summary: z.string().min(20).max(2000),
  recommendation: RecommendationSchema,
  concerns: z.array(ConcernSchema).min(3).max(8),
  evidence: z.array(EvidenceRowSchema).default([]),
})
export type SubmitReviewInput = z.infer<typeof SubmitReviewInputSchema>

/**
 * Persisted shape returned by the repo. JSON columns are parsed at this
 * boundary so callers never see strings.
 */
export interface StressTestReport {
  id: string
  memoId: string
  runId: string
  priorMemoVersionId: string
  summary: string
  concerns: Concern[]
  evidence: import('./thesis').EvidenceRow[]
  recommendation: Recommendation
  costEstimateUsd: number
  durationMs: number
  toolCallCount: number
  createdAt: string
  createdBy: string
}

/** Lightweight row shape for list views — avoids parsing heavy JSON columns. */
export interface StressTestReportSummary {
  id: string
  memoId: string
  runId: string
  summary: string
  recommendation: Recommendation
  concernCount: number
  costEstimateUsd: number
  createdAt: string
}
