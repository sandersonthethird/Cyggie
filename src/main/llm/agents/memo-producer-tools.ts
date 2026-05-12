/**
 * Tool registry for the Memo Producer Agent.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  Tools by category:                                                  │
 *   │   internal_read:                                                     │
 *   │     - internal_search   — FTS5 across meetings/notes for this co.   │
 *   │     - read_document     — full text of a flagged Drive file by name │
 *   │   web:                                                                │
 *   │     - web_search   — exa.searchAndContents; auto-populates per-run  │
 *   │                      allowlist with result URLs                       │
 *   │     - web_fetch    — exa.getContents; rejects URLs NOT in the per-  │
 *   │                      run allowlist (prompt-injection-via-transcript │
 *   │                      exfil mitigation)                                │
 *   │   producer:                                                           │
 *   │     - cite_source     — buffers an EvidenceRow in-memory; persisted │
 *   │                          in end-of-run transaction via persist.ts    │
 *   │     - submit_section  — records one section's markdown body; emits   │
 *   │                          section_completed event                     │
 *   │   terminal:                                                           │
 *   │     - done            — agent's stop signal; refinement validates    │
 *   │                          that all required sections were submitted   │
 *   │                                                                       │
 *   │  Tools close over a per-run MemoProducerRunState that holds the      │
 *   │  mutable per-run state (allowlist, evidence buffer, section map).   │
 *   │  Building tools is a function call, not module load — each agent    │
 *   │  run gets a fresh state. The standard ToolContext (companyId/user/  │
 *   │  runId/signal) is passed via the agent loop alongside.              │
 *   └────────────────────────────────────────────────────────────────────┘
 */

import { defineTool, z, type Tool, type ToolContext } from './define-tool'
import { agentWebSearch, agentWebFetch } from '../../services/exa-research'
import { getDatabase } from '../../database/connection'
import * as companyRepo from '../../database/repositories/org-company.repo'
import { getFlaggedFiles } from '../../database/repositories/company-file-flags.repo'
import { readLocalFile } from '../../storage/file-manager'
import {
  type MemoSection,
  type MemoSectionHeading,
  canonicalizeUrl,
  isMemoSectionHeading,
} from '../memo/sections'
import type { EvidenceRow } from '../../../shared/types/thesis'
import type { AgentEvent } from '../../../shared/types/agent-events'

/** Per-run state shared across all producer tools (closure-captured). */
export interface MemoProducerRunState {
  /** The pinned company for this run (also on ToolContext; kept here for symmetry). */
  companyId: string
  /** Used in event payloads + system prompt; doesn't enforce anything. */
  companyName: string
  /** Mutable per-run URL allowlist for web_fetch. Canonical strings. */
  webFetchAllowlist: Set<string>
  /** Accumulating evidence rows. Persisted atomically at end of run. Capped at 200. */
  evidenceBuffer: EvidenceRow[]
  /** Heading → submitted markdown body. Used for assembly + done() refinement. */
  submittedSections: Map<MemoSectionHeading, { body: string; submittedAt: number }>
  /** The roster the agent must complete (already filtered by gates). */
  sectionRoster: readonly MemoSection[]
  /** Event sink (forwarded to renderer + run-store). */
  emit: (event: AgentEvent) => void
}

/** Cap from review decision #6. */
export const EVIDENCE_BUFFER_CAP = 200
/** Max char-cap on a single claim_text. Matches existing EvidenceRow Zod constraint. */
const CLAIM_TEXT_MAX = 2000

/**
 * Build the producer agent's tool list bound to the given run state.
 * The list is heterogeneous and type-erased at the boundary (same pattern as
 * THESIS_STRESS_TEST_TOOLS).
 */
export function buildMemoProducerTools(state: MemoProducerRunState): Tool[] {
  return [
    internalSearch(state),
    readDocument(state),
    webSearch(state),
    webFetch(state),
    citeSource(state),
    submitSection(state),
    done(state),
  ] as unknown as Tool[]
}

// ─── internal_search ─────────────────────────────────────────────────────

/**
 * FTS5 search across the company's meetings + notes. Single UNION query
 * (no N+1). Returns top 5 hits with surrounding text and source ref so the
 * model can decide what to read in full (via read_document for files, or
 * cite later via cite_source for retrieved snippets).
 */
function internalSearch(state: MemoProducerRunState) {
  return defineTool({
    name: 'internal_search',
    description:
      'Search FTS5-indexed company data (meetings + notes) for keywords. Returns up to 5 hits with surrounding snippets and source refs (meeting_id, note_id). Faster + cheaper than reading full transcripts.',
    category: 'internal_read',
    input: z.object({
      query: z.string().min(2).max(200),
      scope: z.enum(['transcripts', 'notes', 'all']).optional().default('all'),
    }),
    output: { maxChars: 6_000 },
    handler: ({ query, scope }, ctx: ToolContext) => {
      const db = getDatabase()
      const hits: Array<{
        source: 'meeting' | 'note'
        sourceId: string
        title: string
        date: string | null
        snippet: string
      }> = []

      if (scope === 'all' || scope === 'transcripts') {
        // meetings_fts indexes meeting title + summary + transcript. Filter to
        // meetings linked to this run's company.
        const linkedMeetingIds = companyRepo
          .listCompanyMeetings(ctx.companyId)
          .map((m) => m.id)
        if (linkedMeetingIds.length > 0) {
          // FTS5 doesn't support parameterized IN; build placeholders.
          const placeholders = linkedMeetingIds.map(() => '?').join(',')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = db
            .prepare(
              `SELECT m.id AS id, m.title AS title, m.date AS date,
                      snippet(meetings_fts, -1, '«', '»', '…', 16) AS snippet
                 FROM meetings_fts
                 JOIN meetings m ON m.id = meetings_fts.meeting_id
                WHERE meetings_fts MATCH ?
                  AND meetings_fts.meeting_id IN (${placeholders})
                ORDER BY bm25(meetings_fts) LIMIT 5`,
            )
            .all(query, ...linkedMeetingIds) as Array<{
              id: string
              title: string
              date: string | null
              snippet: string
            }>
          for (const r of rows) {
            hits.push({
              source: 'meeting',
              sourceId: r.id,
              title: r.title,
              date: r.date,
              snippet: r.snippet,
            })
          }
        }
      }

      if (scope === 'all' || scope === 'notes') {
        // Naive substring fallback for notes — keep simple; notes are usually
        // a handful per company, so cost is negligible.
        const lower = query.toLowerCase()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const noteRows = db
          .prepare(
            `SELECT n.id AS id, n.title AS title, n.content AS content, n.created_at AS date
               FROM notes n
              WHERE n.company_id = ?
                AND (LOWER(n.title) LIKE ? OR LOWER(n.content) LIKE ?)
              ORDER BY datetime(n.created_at) DESC LIMIT 5`,
          )
          .all(ctx.companyId, `%${lower}%`, `%${lower}%`) as Array<{
            id: string
            title: string | null
            content: string
            date: string
          }>
        for (const r of noteRows) {
          // 200-char window around first match.
          const idx = r.content.toLowerCase().indexOf(lower)
          const start = Math.max(0, idx - 80)
          const end = Math.min(r.content.length, idx + 120)
          const snippet = (start > 0 ? '…' : '') + r.content.slice(start, end) + (end < r.content.length ? '…' : '')
          hits.push({
            source: 'note',
            sourceId: r.id,
            title: r.title ?? '(untitled note)',
            date: r.date,
            snippet,
          })
        }
      }

      return { query, scope, hits: hits.slice(0, 5) }
    },
  })
}

// ─── read_document ───────────────────────────────────────────────────────

function readDocument(state: MemoProducerRunState) {
  return defineTool({
    name: 'read_document',
    description:
      'Read the extracted text of a flagged Drive file by file name. Use for full pitch decks, financial models, etc. that need to be inspected in detail.',
    category: 'internal_read',
    input: z.object({ file_name: z.string().min(1) }),
    output: { maxChars: 8_000 },
    handler: async ({ file_name }, ctx: ToolContext) => {
      void state // closure-only binding (for future extension)
      const flagged = getFlaggedFiles(ctx.companyId)
      // Case-insensitive name match. If multiple files share a name, pick the
      // first; the agent can disambiguate via internal_search if needed.
      const match = flagged.find((f) => f.fileName.toLowerCase() === file_name.toLowerCase())
      if (!match) {
        return {
          error: 'file_not_found',
          available: flagged.map((f) => f.fileName).slice(0, 20),
        }
      }
      const content = await readLocalFile(match.fileId, match.mimeType ?? undefined)
      if (!content || content.trim().length < 100) {
        return { error: 'file_unreadable_or_empty', fileName: match.fileName }
      }
      return { fileName: match.fileName, content }
    },
  })
}

// ─── web_search ──────────────────────────────────────────────────────────

function webSearch(state: MemoProducerRunState) {
  return defineTool({
    name: 'web_search',
    description:
      'Search the web (Exa) for market data, competitor info, news, founder background. Returns top 5 snippets. Result URLs automatically become fetchable via web_fetch.',
    category: 'web',
    input: z.object({ query: z.string().min(2).max(500) }),
    output: { maxChars: 9_000 },
    handler: async ({ query }) => {
      const result = await agentWebSearch(query)
      if ('error' in result) return result
      // Populate per-run allowlist with each canonicalized result URL so the
      // model can web_fetch them on the next iteration.
      for (const r of result.results) {
        const canon = canonicalizeUrl(r.url)
        if (canon) state.webFetchAllowlist.add(canon)
      }
      return result
    },
  })
}

// ─── web_fetch ───────────────────────────────────────────────────────────

function webFetch(state: MemoProducerRunState) {
  return defineTool({
    name: 'web_fetch',
    description:
      'Fetch full text of a URL via Exa. URL must have been surfaced earlier in this run (via web_search results, or pre-populated from CRM-stored LinkedIn URLs / flagged-file citations). Arbitrary URLs from transcripts/notes are rejected.',
    category: 'web',
    input: z.object({ url: z.string().url() }),
    output: { maxChars: 10_000 },
    handler: async ({ url }) => {
      const canon = canonicalizeUrl(url)
      if (!canon) {
        return { error: 'invalid_url', code: 'invalid_url' }
      }
      if (!state.webFetchAllowlist.has(canon)) {
        return {
          error:
            'URL not in producer allowlist. The producer agent can only fetch URLs surfaced earlier in the run (web_search results or CRM-stored references). Call web_search to find this content instead.',
          code: 'allowlist_denied',
        }
      }
      return agentWebFetch(url)
    },
  })
}

// ─── cite_source ─────────────────────────────────────────────────────────

const CiteSourceInputSchema = z.object({
  section: z.string().min(1),
  claimText: z.string().min(1).max(CLAIM_TEXT_MAX),
  claimCategory: z.enum(['market', 'team', 'traction', 'risk', 'competition', 'general']).optional(),
  sourceType: z.enum(['meeting', 'note', 'email', 'drive_file', 'web', 'contact']),
  sourceId: z.string().optional().nullable(),
  sourceUrl: z.string().url().optional().nullable(),
  snippet: z.string().min(1).max(500),
  confidence: z.enum(['high', 'medium', 'low']),
})

function citeSource(state: MemoProducerRunState) {
  return defineTool({
    name: 'cite_source',
    description:
      'Record an evidence row for a factual claim about to be (or recently) included in a section. Internal sources need sourceId; web sources need sourceUrl. Buffered until end-of-run; persisted atomically with the memo version. Max 200 calls per run.',
    category: 'internal_read',
    input: CiteSourceInputSchema,
    output: { maxChars: 200 },
    handler: (input) => {
      // Buffer cap.
      if (state.evidenceBuffer.length >= EVIDENCE_BUFFER_CAP) {
        return {
          error: 'evidence_cap_reached',
          code: 'evidence_cap_reached',
          message: `Producer agent cite_source buffer is full (${EVIDENCE_BUFFER_CAP} rows). Skip further citations for low-importance claims; focus on the most important.`,
        }
      }

      // Section must be a known heading. We allow the model to cite sources
      // PRIOR to submitting that section (recommended workflow), so the
      // section's body need not exist yet — only the heading must be valid.
      if (!isMemoSectionHeading(input.section)) {
        return { error: 'invalid_section', valid: state.sectionRoster.map((s) => s.heading) }
      }

      // Cross-source validation (matches EvidenceRowSchema.superRefine logic;
      // we re-check here to short-circuit before adding to buffer).
      if (input.sourceType === 'web' && !input.sourceUrl) {
        return { error: 'web evidence requires a sourceUrl' }
      }
      if (input.sourceType !== 'web' && !input.sourceId) {
        return { error: `${input.sourceType} evidence requires a sourceId` }
      }

      // Defense-in-depth: even though we don't fetch sourceUrl here, sanitize
      // it (it'll be rendered in the EvidenceSidebar as a clickable link).
      // canonicalizeUrl returns null for non-http(s) or malformed URLs.
      if (input.sourceUrl && !canonicalizeUrl(input.sourceUrl)) {
        return { error: 'sourceUrl is not a valid http(s) URL' }
      }

      const row: EvidenceRow = {
        claimText: input.claimText,
        claimCategory: input.claimCategory,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        snippet: input.snippet,
        confidence: input.confidence,
        isCritique: false,
      }
      state.evidenceBuffer.push(row)
      return { ok: true, total: state.evidenceBuffer.length }
    },
  })
}

// ─── submit_section ──────────────────────────────────────────────────────

const SubmitSectionInputSchema = z.object({
  heading: z.string().min(1),
  body_markdown: z.string().min(1),
})

function submitSection(state: MemoProducerRunState) {
  return defineTool({
    name: 'submit_section',
    description:
      'Submit one section\'s markdown body. Call once per section in roster order. The heading must match the roster exactly. Body must NOT begin with a `##` heading at column 0 (it will be rendered under the auto-emitted `## <heading>` line). Synthesis sections may include a leading <thinking>...</thinking> block; it will be stripped before assembly.',
    category: 'internal_read',
    input: SubmitSectionInputSchema,
    output: { maxChars: 200 },
    handler: (input, ctx: ToolContext) => {
      if (!isMemoSectionHeading(input.heading)) {
        return { error: 'invalid_heading', valid: state.sectionRoster.map((s) => s.heading) }
      }
      // Confirm the heading is in this run's filtered roster (gates respected).
      const inRoster = state.sectionRoster.find((s) => s.heading === input.heading)
      if (!inRoster) {
        return {
          error: 'section_not_in_run_roster',
          message: `Section "${input.heading}" is not included in this run (probably gated out — e.g. Valuation is only emitted for Series A+). Skip and continue.`,
        }
      }
      if (state.submittedSections.has(input.heading)) {
        return { error: 'section_already_submitted', heading: input.heading }
      }
      const body = input.body_markdown.replace(/\s+$/, '')
      if (body.length === 0) {
        return { error: 'empty_body' }
      }
      // Reject leading `## ` at column 0 — would create a duplicate heading.
      // We allow ### subheadings within a section body.
      if (/^##\s/m.test(body.split('\n', 1)[0] ?? '')) {
        return {
          error: 'body_starts_with_h2',
          message:
            'body_markdown must not start with `## ` — the assembler emits the section heading. Submit content only.',
        }
      }
      state.submittedSections.set(input.heading, { body, submittedAt: Date.now() })
      state.emit({
        type: 'section_completed',
        runId: ctx.runId,
        heading: input.heading,
        bodyLength: body.length,
      })
      return { ok: true, submitted: state.submittedSections.size, of: state.sectionRoster.length }
    },
  })
}

// ─── done (terminal) ─────────────────────────────────────────────────────

const DoneInputSchema = z.object({})

function done(state: MemoProducerRunState) {
  return defineTool({
    name: 'done',
    description:
      'Call when every required section has been submitted via submit_section. Refinement validates that all required sections in the run roster are present; if any are missing, the call fails with a list of the missing headings and the agent should call submit_section for each before retrying done.',
    terminal: true,
    category: 'terminal',
    input: DoneInputSchema,
    output: { maxChars: 500 },
    handler: () => {
      const required = state.sectionRoster.filter((s) => s.required).map((s) => s.heading)
      const missing = required.filter((h) => !state.submittedSections.has(h))
      if (missing.length > 0) {
        return {
          error: 'required_sections_missing',
          missing,
          message: `Cannot call done(): required sections [${missing.join(', ')}] have not been submitted. Call submit_section for each before done().`,
        }
      }
      return {
        ok: true,
        submitted: state.submittedSections.size,
        evidenceRows: state.evidenceBuffer.length,
      }
    },
  })
}
