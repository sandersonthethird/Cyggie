import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { getDatabase } from '../../database/connection'

/**
 * Context budget manager for the memo producer agent.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  At run-start, the producer agent assembles an initial user message │
 *   │  containing internal data + Exa pre-research. Active companies       │
 *   │  produce wildly variable context sizes:                              │
 *   │    • New deal w/ 1 meeting:        ~20-40k tokens                    │
 *   │    • Active deal w/ 5 meetings:    ~80-120k tokens                   │
 *   │    • Portfolio w/ 30+ meetings:    ~400k+ tokens (OVER 200k window)  │
 *   │                                                                      │
 *   │  This module bounds that load:                                       │
 *   │    1. Pre-allocate budget slots (raw transcripts, summarized, notes, │
 *   │       contacts, files, output reserve)                                │
 *   │    2. Count tokens via Anthropic API (accurate vs. char heuristics)  │
 *   │    3. If over: displace oldest raw transcripts → Haiku-summarized   │
 *   │       form via caller-provided callback (kept testable)              │
 *   │    4. Cache summaries in transcript_summaries table keyed on path +  │
 *   │       content hash so re-runs don't re-pay                            │
 *   │    5. If still over after all displacements: HARD ERROR              │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * The agent's tool-call running context is bounded separately by
 * agent-loop.ts (TOOL_RESULT_PRE_TRUNC_CHARS + SUMMARIZE_OLDER_THAN_TURNS).
 */

/** Hard ceiling: leave 20k tokens of headroom under Sonnet 4.5's 200k window. */
export const TOKEN_BUDGET_CEILING = 180_000

export interface ContextBudgetConfig {
  /** Char-counts approximated for the warning UI; not enforced. */
  systemScaffoldTokens: number
  recentRawTranscriptsBudgetTokens: number
  summarizedTranscriptsBudgetTokens: number
  notesAndContactsBudgetTokens: number
  toolResultRunningBufferTokens: number
  outputReserveTokens: number
}

export const DEFAULT_BUDGET: ContextBudgetConfig = {
  systemScaffoldTokens: 5_000,
  recentRawTranscriptsBudgetTokens: 60_000,
  summarizedTranscriptsBudgetTokens: 20_000,
  notesAndContactsBudgetTokens: 40_000,
  toolResultRunningBufferTokens: 25_000,
  outputReserveTokens: 50_000,
}

export interface MeetingTranscriptInput {
  id: string
  title: string
  date: string
  /** Absolute path to the transcript file on disk. Used as cache key. */
  transcriptPath: string
  /** Loaded content (caller reads from disk). Empty string if no transcript. */
  content: string
}

export interface ContextAllocationInput {
  anthropic: Anthropic
  model: string
  /** Sorted by date DESC (most recent first). Empty content rows are filtered. */
  meetings: MeetingTranscriptInput[]
  /** Pre-formatted blocks the agent sees verbatim. Caller composes. */
  scaffold: string
  /** Optional override of default budget for testing / per-run tuning. */
  budget?: Partial<ContextBudgetConfig>
  /**
   * Called when a raw transcript must be displaced to summarized form and no
   * cache hit exists. Caller wires this to a Haiku call.
   *
   * MUST return a 1-3 paragraph summary capturing pitch, terms, key updates.
   * Result is cached in transcript_summaries on success.
   */
  summarize: (input: { title: string; date: string; content: string }) => Promise<string>
}

export interface AllocatedContext {
  /** Full text included verbatim. Sorted recent-first. */
  rawTranscripts: Array<{ id: string; title: string; date: string; content: string }>
  /** Replaced with cached/freshly-generated summary. Sorted recent-first within their slot. */
  summarizedTranscripts: Array<{ id: string; title: string; date: string; summary: string }>
  /** Sum of estimated tokens across scaffold + rawTranscripts + summarizedTranscripts. */
  estimatedTokens: number
  /** Counts of what happened, surfaced in agent_runs for observability. */
  meta: {
    transcriptsKept: number
    transcriptsDisplaced: number
    summaryCacheHits: number
    summaryCacheMisses: number
  }
}

export class ContextOverflowError extends Error {
  readonly code = 'CONTEXT_OVERFLOW'
  constructor(readonly tokens: number, readonly suggestion: string) {
    super(`Context budget exceeded (${tokens} tokens). ${suggestion}`)
    this.name = 'ContextOverflowError'
  }
}

/**
 * Allocate context for one producer agent run.
 *
 * Strategy:
 *   1. Try fitting ALL transcripts raw. If under budget, done.
 *   2. Otherwise, displace from the oldest end. Replace each displaced raw
 *      transcript with a cached or freshly-summarized variant.
 *   3. Re-check token count after each displacement.
 *   4. If after displacing ALL transcripts we're still over budget, throw
 *      ContextOverflowError with a user-actionable suggestion.
 *
 * Network calls: one countTokens per remaining-meetings probe (bounded to ~N
 * for N meetings). Haiku summarization calls only on cache miss.
 */
export async function allocateContext(
  input: ContextAllocationInput,
): Promise<AllocatedContext> {
  const budget = { ...DEFAULT_BUDGET, ...input.budget }
  // The slots that user-context (transcripts + scaffold) compete for.
  const userContextBudget =
    budget.recentRawTranscriptsBudgetTokens +
    budget.summarizedTranscriptsBudgetTokens +
    budget.notesAndContactsBudgetTokens +
    budget.systemScaffoldTokens

  // Filter empty transcripts up front — saves API calls.
  const meetings = input.meetings.filter((m) => m.content.trim().length > 0)

  const meta = {
    transcriptsKept: meetings.length,
    transcriptsDisplaced: 0,
    summaryCacheHits: 0,
    summaryCacheMisses: 0,
  }

  // Helper: count tokens for the current proposed assembly.
  const countTokens = async (raw: typeof meetings, summarized: Array<{ summary: string }>) => {
    const text =
      input.scaffold +
      raw.map((t) => `### ${t.title} (${t.date})\n${t.content}`).join('\n\n') +
      summarized.map((t) => `### Summary\n${t.summary}`).join('\n\n')
    return countAnthropicTokens(input.anthropic, input.model, text)
  }

  let rawMeetings = [...meetings]
  let summarized: Array<{ id: string; title: string; date: string; summary: string }> = []

  let estimatedTokens = await countTokens(rawMeetings, summarized)

  // Displace oldest raw → summarized until we're under budget OR we've
  // displaced everything. `meetings` is sorted recent-first, so pop from end.
  while (estimatedTokens > userContextBudget && rawMeetings.length > 0) {
    const oldest = rawMeetings[rawMeetings.length - 1]
    rawMeetings = rawMeetings.slice(0, -1)
    const summary = await getOrCreateSummary({
      meeting: oldest,
      summarize: input.summarize,
      meta,
    })
    if (summary) {
      summarized.unshift({
        id: oldest.id,
        title: oldest.title,
        date: oldest.date,
        summary,
      })
    }
    meta.transcriptsDisplaced += 1
    estimatedTokens = await countTokens(rawMeetings, summarized)
  }

  if (estimatedTokens > TOKEN_BUDGET_CEILING) {
    throw new ContextOverflowError(
      estimatedTokens,
      'Reduce flagged files or select fewer meetings to fit within the model context window.',
    )
  }

  // Sort summarized: recent-first within their slot.
  summarized.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))

  return {
    rawTranscripts: rawMeetings.map((m) => ({
      id: m.id,
      title: m.title,
      date: m.date,
      content: m.content,
    })),
    summarizedTranscripts: summarized,
    estimatedTokens,
    meta,
  }
}

// ─── Anthropic token counting ─────────────────────────────────────────────

/**
 * Count tokens for a single user message via Anthropic's API. The SDK exposes
 * `messages.countTokens(...)`; the call is cheap (~100-200ms) and accurate.
 *
 * Returns 0 on API failure — caller treats as "unknown, assume small." The
 * loop's own input_tokens cap is the backstop.
 */
async function countAnthropicTokens(
  client: Anthropic,
  model: string,
  text: string,
): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await (client.messages as any).countTokens({
      model,
      messages: [{ role: 'user', content: text }],
    })) as { input_tokens: number }
    return res.input_tokens
  } catch (err) {
    console.warn('[context-budget] countTokens failed, falling back to char/4 heuristic:', (err as Error).message)
    return Math.floor(text.length / 4)
  }
}

// ─── Transcript summary cache (transcript_summaries table) ─────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

interface CachedSummaryRow {
  summary: string
  token_count: number
}

/**
 * Look up cached summary by (transcript_path, content_hash). Miss → call the
 * caller-provided summarize fn and write the result to cache. Returns null
 * only if the summarize call fails (and the cache lookup also missed).
 */
async function getOrCreateSummary(args: {
  meeting: MeetingTranscriptInput
  summarize: ContextAllocationInput['summarize']
  meta: AllocatedContext['meta']
}): Promise<string | null> {
  const hash = hashContent(args.meeting.content)
  const db = getDatabase()
  const cached = db
    .prepare(`SELECT summary, token_count FROM transcript_summaries WHERE transcript_path = ? AND content_hash = ?`)
    .get(args.meeting.transcriptPath, hash) as CachedSummaryRow | undefined

  if (cached) {
    args.meta.summaryCacheHits += 1
    return cached.summary
  }

  args.meta.summaryCacheMisses += 1
  let summary: string
  try {
    summary = await args.summarize({
      title: args.meeting.title,
      date: args.meeting.date,
      content: args.meeting.content,
    })
  } catch (err) {
    console.warn(
      `[context-budget] summarize failed for ${args.meeting.transcriptPath}:`,
      (err as Error).message,
    )
    return null
  }

  // Write-through cache. Best-effort — ignore errors so a write failure
  // doesn't break the run.
  try {
    db.prepare(
      `INSERT OR REPLACE INTO transcript_summaries (transcript_path, content_hash, summary, token_count) VALUES (?, ?, ?, ?)`,
    ).run(args.meeting.transcriptPath, hash, summary, Math.floor(summary.length / 4))
  } catch (err) {
    console.warn('[context-budget] transcript_summaries cache write failed:', (err as Error).message)
  }

  return summary
}
