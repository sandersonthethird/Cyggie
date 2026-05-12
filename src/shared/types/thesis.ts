import { z } from 'zod'

/**
 * Schemas for the Investment Thesis Agent's structured output.
 *
 * The agent's terminal tool is `submit_memo({ markdown, evidence })`. Anthropic
 * validates the tool input against the JSON Schema we register; we then re-validate
 * with these Zod schemas as defense in depth before persisting to SQLite.
 *
 * Confidence:
 *   high   → claim is grounded in multiple independent sources
 *   medium → single source, or partial corroboration
 *   low    → speculative / inferred / weak evidence
 *
 * Severity (only for is_critique=true rows):
 *   high   → invalidates the thesis if confirmed
 *   medium → meaningful concern; partner should probe
 *   low    → minor wrinkle; flag-and-watch
 *
 * Evidence categories track the memo section the claim belongs to. The agent
 * stress-tests claims in market/team/traction/risk/competition/general; sources
 * follow the tool family the agent used to gather them.
 */

export const ConfidenceSchema = z.enum(['high', 'medium', 'low'])
export type Confidence = z.infer<typeof ConfidenceSchema>

export const SeveritySchema = z.enum(['high', 'medium', 'low'])
export type Severity = z.infer<typeof SeveritySchema>

export const ClaimCategorySchema = z.enum([
  'market',
  'team',
  'traction',
  'risk',
  'competition',
  'general',
])
export type ClaimCategory = z.infer<typeof ClaimCategorySchema>

export const SourceTypeSchema = z.enum([
  'meeting',
  'note',
  'email',
  'drive_file',
  'web',
  'contact',
])
export type SourceType = z.infer<typeof SourceTypeSchema>

/**
 * Single evidence row produced by the agent. Internal sources fill `sourceId`
 * (e.g. meeting id, note id); web sources fill `sourceUrl`. Both can technically
 * coexist for hybrid cases (a drive file with a public URL), but exactly one
 * is the primary key for dedupe per the partial unique indexes in migration 085.
 */
export const EvidenceRowSchema = z
  .object({
    claimText: z.string().min(1).max(2000),
    claimCategory: ClaimCategorySchema.optional(),
    sourceType: SourceTypeSchema,
    sourceId: z.string().nullable().optional(),
    sourceUrl: z.string().url().nullable().optional(),
    snippet: z.string().min(1).max(500),
    confidence: ConfidenceSchema,
    severity: SeveritySchema.nullable().optional(),
    isCritique: z.boolean().default(false),
    /**
     * The memo section this evidence row belongs to (e.g. "Market / Industry").
     * Populated by the producer agent's cite_source tool; null for stress-test
     * agent rows and legacy rows (pre-migration 090). Used by the section
     * hover popover to attribute evidence back to its source section.
     */
    section: z.string().nullable().optional(),
  })
  .superRefine((row, ctx) => {
    // Internal source rows must have a sourceId; web rows must have a sourceUrl.
    if (row.sourceType === 'web' && !row.sourceUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceUrl'],
        message: 'web evidence requires a sourceUrl',
      })
    }
    if (row.sourceType !== 'web' && !row.sourceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceId'],
        message: `${row.sourceType} evidence requires a sourceId`,
      })
    }
    // Severity is only meaningful for critique-type evidence.
    if (row.severity && !row.isCritique) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['severity'],
        message: 'severity is only valid when isCritique is true',
      })
    }
  })

export type EvidenceRow = z.infer<typeof EvidenceRowSchema>

/**
 * The agent's terminal `submit_memo` tool input. The agent emits the full
 * memo markdown plus the structured evidence list. The IPC handler persists
 * both transactionally (memo version + bulk evidence rows).
 */
export const SubmitMemoInputSchema = z.object({
  markdown: z.string().min(1),
  evidence: z.array(EvidenceRowSchema).default([]),
})

export type SubmitMemoInput = z.infer<typeof SubmitMemoInputSchema>
