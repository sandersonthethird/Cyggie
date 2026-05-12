/**
 * Generic Anthropic tool-use agent loop. Shared by:
 *   • thesis-stress-test-agent — terminal tool: submit_memo
 *   • memo-producer-agent      — terminal tool: done (called after N
 *                                non-terminal submit_section calls)
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │  while (iter < cap):                                                 │
 *   │    1. abort?                          → emit 'aborted', return       │
 *   │    2. apply older-turn summarization  → bound cumulative context     │
 *   │    3. pre-check input_tokens cap      → emit 'cap_exceeded', return  │
 *   │    4. messages.create  (with retry)   → 401 fail-fast; 5xx retry 1×; │
 *   │                                          429 retry 2× w/ Retry-After  │
 *   │       enableThinking? add `thinking`  → Anthropic extended thinking; │
 *   │                                          response includes thinking  │
 *   │                                          AND text blocks; loop reads │
 *   │                                          only text. Used by producer.│
 *   │    5. accumulate usage; emit 'thinking' event for any text block      │
 *   │                                          (legacy event name; refers   │
 *   │                                          to model preamble text, NOT  │
 *   │                                          the API's thinking blocks)   │
 *   │    6. extract tool_use blocks                                        │
 *   │       a. terminal_tool present?                                       │
 *   │            validate input via Zod →                                   │
 *   │              SUCCESS: dispatch any same-turn non-terminal tools      │
 *   │                       (commit side effects), then finalize('success')│
 *   │              FAILURE: push tool_result(is_error: true) + dispatch    │
 *   │                       same-turn non-terminals + continue loop;       │
 *   │                       model retries terminal on next iteration       │
 *   │       b. max_tokens mid-tool?         → fail (incomplete sequence)   │
 *   │       c. else dispatch each tool;     → push tool_result blocks;     │
 *   │                                          enforce web_search cap       │
 *   │    7. append assistant turn + user turn (tool_results) to messages   │
 *   │  iteration cap reached → emit 'cap_exceeded'                          │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Stop condition: model called the terminal tool. For the producer agent
 * that's `done({})` — its Zod refinement validates that all required
 * sections were submitted via prior non-terminal submit_section calls.
 *
 * Context budget: tool results are aggressively pre-truncated to
 * TOOL_RESULT_PRE_TRUNC_CHARS at receipt; AND tool results older than
 * SUMMARIZE_OLDER_THAN_TURNS are replaced with a fixed-size placeholder. This
 * bounds cumulative input_tokens by design rather than dropping at the cap edge.
 *
 * Concurrency: the caller owns the AbortController; the loop honors signal at
 * every iteration boundary AND between tool calls within a turn.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type {
  Message,
  MessageParam,
  ToolUseBlock,
  ToolResultBlockParam,
  Usage,
} from '@anthropic-ai/sdk/resources/messages/messages'
import { findTerminalTool, buildToolRegistry, type Tool, type ToolContext } from './define-tool'
import type { AgentEvent, AgentRunMode } from '../../../shared/types/agent-events'
import type { AgentLimits } from './limits'

export interface AgentPricing {
  inputPerM: number
  outputPerM: number
}

const DEFAULT_PRICING: AgentPricing = { inputPerM: 3, outputPerM: 15 }   // Sonnet 4.5
const TOOL_RESULT_PRE_TRUNC_CHARS = 4_000
const SUMMARIZE_OLDER_THAN_TURNS = 2
const MAX_RETRY_5XX = 1
const MAX_RETRY_429 = 2
const RETRY_5XX_BACKOFF_MS = 1_000
const DEFAULT_RETRY_AFTER_MS = 2_000

export interface RunAgentLoopOptions {
  client: Anthropic
  model: string
  systemPrompt: string
  initialUserMessage: string
  tools: Tool[]
  ctx: ToolContext
  limits: AgentLimits
  emit: (e: AgentEvent) => void
  signal: AbortSignal
  pricing?: AgentPricing
  /** Bookkeeping for emitted events; not used by the loop itself. */
  runId: string
  kind: string
  mode: AgentRunMode
  companyId: string
  /**
   * When true, every iteration's messages.create call enables Anthropic
   * extended thinking. The model self-allocates thinking tokens up to
   * `thinkingBudgetTokens` (default 2048; clamped to Anthropic's 1024 min).
   * Thinking content blocks are NOT emitted as 'thinking' events to avoid
   * leaking model reasoning to the renderer — only the text content blocks
   * are surfaced. Caller (the producer agent) is the consumer.
   */
  enableThinking?: boolean
  thinkingBudgetTokens?: number
  /**
   * Anthropic prompt-cache TTL. Defaults to '5m' (ephemeral). When '1h', the
   * caller MUST construct its Anthropic client with the matching beta header
   * (`extended-cache-ttl-2025-04-11`) — see model-tier.ts EXTENDED_CACHE_TTL_BETA.
   * The loop only applies the value to cache_control blocks; client-side
   * headers are the caller's responsibility.
   */
  cacheTtl?: '5m' | '1h'
}

export interface AgentRunResult {
  status: 'success' | 'failed' | 'aborted' | 'cap_exceeded'
  /** When status==='success', the validated input passed to the terminal tool. */
  terminalToolInput?: unknown
  iterations: number
  inputTokensTotal: number
  outputTokensTotal: number
  /** Tokens read from Anthropic prompt cache. Billed at 0.1× input rate. */
  cacheReadTokensTotal: number
  /** Tokens written to Anthropic prompt cache. Billed at 1.25× input rate. */
  cacheCreateTokensTotal: number
  costEstimateUsd: number
  toolCallCount: number
  webSearchCount: number
  durationMs: number
  errorClass?: string
  errorMessage?: string
}

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<AgentRunResult> {
  const start = Date.now()
  const pricing = opts.pricing ?? DEFAULT_PRICING
  const terminal = findTerminalTool(opts.tools)
  const registry = buildToolRegistry(opts.tools)
  // Anthropic SDK's `tools` typing is a union of (custom Tool | hosted helpers
  // like web_search/text_editor). Our tools are custom; cast at the boundary.
  const anthropicTools = opts.tools.map(t => t.toAnthropicTool()) as unknown as
    Parameters<Anthropic['messages']['create']>[0]['tools']

  let iterations = 0
  let inputTokensTotal = 0
  let outputTokensTotal = 0
  let cacheReadTokensTotal = 0
  let cacheCreateTokensTotal = 0
  let toolCallCount = 0
  let webSearchCount = 0

  // Prompt-cache breakpoint #3 (of 3): the initial user message contains the
  // scaffold (company overview, notes, transcripts, Exa research) — stable
  // across all iterations within a run. Wrap as an array with cache_control
  // so iterations 2+ hit cache for this prefix.
  const cacheControl: { type: 'ephemeral'; ttl?: '1h' } = { type: 'ephemeral' }
  if (opts.cacheTtl === '1h') cacheControl.ttl = '1h'

  let messages: MessageParam[] = [
    {
      role: 'user',
      content: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'text', text: opts.initialUserMessage, cache_control: cacheControl } as any,
      ],
    },
  ]

  opts.emit({
    type: 'started',
    runId: opts.runId,
    kind: opts.kind,
    companyId: opts.companyId,
    mode: opts.mode,
    caps: {
      iterations: opts.limits.iterations,
      webSearches: opts.limits.webSearches,
      inputTokens: opts.limits.inputTokens,
    },
  })

  while (iterations < opts.limits.iterations) {
    if (opts.signal.aborted) {
      opts.emit({ type: 'aborted', runId: opts.runId })
      return finalize('aborted', undefined)
    }

    iterations += 1
    opts.emit({ type: 'iteration_start', runId: opts.runId, n: iterations })

    // Bound cumulative context: replace older-than-2-turns tool results with
    // fixed-size placeholders. Recent turns stay intact for citation/grounding.
    messages = summarizeOlderTurns(messages, iterations)

    // Cost cap pre-check.
    if (inputTokensTotal >= opts.limits.inputTokens) {
      opts.emit({
        type: 'cap_exceeded',
        runId: opts.runId,
        cap: 'input_tokens',
        limit: opts.limits.inputTokens,
        used: inputTokensTotal,
      })
      return finalize('cap_exceeded', undefined, 'CapExceeded', `input_tokens cap ${opts.limits.inputTokens} reached`)
    }

    let response: Message
    try {
      // Cache breakpoints #1 (system) + #2 (tools): wrap system as a content
      // block array w/ cache_control, and tag the LAST tool with cache_control
      // (caches everything up to and including it). Combined with the initial
      // user message (breakpoint #3, set above when initializing `messages`),
      // we use 3 of Anthropic's 4 allowed breakpoints per request.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const systemBlocks: any = [
        { type: 'text', text: opts.systemPrompt, cache_control: cacheControl },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolsWithCache: any = anthropicTools
        ? (anthropicTools as unknown as unknown[]).map((t, i, arr) =>
            i === arr.length - 1 ? { ...(t as object), cache_control: cacheControl } : t,
          )
        : anthropicTools

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = {
        model: opts.model,
        max_tokens: 8192,
        system: systemBlocks,
        tools: toolsWithCache,
        messages,
      }
      if (opts.enableThinking) {
        // Anthropic requires budget_tokens >= 1024 when thinking is enabled.
        params.thinking = {
          type: 'enabled',
          budget_tokens: Math.max(1024, opts.thinkingBudgetTokens ?? 2048),
        }
      }
      response = await callWithRetry(opts.client, params, opts.signal)
    } catch (err) {
      const errClass = err instanceof Error ? err.name : 'Error'
      const errMsg = err instanceof Error ? err.message : String(err)
      // AbortError surfaces here when signal fires inside messages.create
      if (errClass === 'AbortError' || opts.signal.aborted) {
        opts.emit({ type: 'aborted', runId: opts.runId })
        return finalize('aborted', undefined)
      }
      opts.emit({ type: 'error', runId: opts.runId, errorClass: errClass, message: errMsg })
      return finalize('failed', undefined, errClass, errMsg)
    }

    inputTokensTotal += getInputTokens(response.usage)
    outputTokensTotal += response.usage.output_tokens ?? 0
    // Anthropic populates cache_*_tokens fields when prompt caching is
    // active. SDK types these as number | null; coerce to 0 for accounting.
    // input_tokens excludes cached portions, so accumulating these
    // separately yields a complete picture of the request size.
    cacheReadTokensTotal += response.usage.cache_read_input_tokens ?? 0
    cacheCreateTokensTotal += response.usage.cache_creation_input_tokens ?? 0

    // Emit thinking text if present.
    const textBlocks = response.content.filter(b => b.type === 'text')
    if (textBlocks.length > 0) {
      const text = textBlocks.map(b => (b as { text: string }).text).join('')
      if (text.trim()) {
        opts.emit({ type: 'thinking', runId: opts.runId, text: text.slice(0, 500) })
      }
    }

    const toolUses = response.content.filter(b => b.type === 'tool_use') as ToolUseBlock[]

    if (toolUses.length === 0) {
      const stopReason = response.stop_reason
      const errMsg = `agent finished without calling terminal tool '${terminal.name}' (stop_reason=${stopReason ?? 'unknown'})`
      opts.emit({ type: 'error', runId: opts.runId, errorClass: 'NoToolUse', message: errMsg })
      return finalize('failed', undefined, 'NoToolUse', errMsg)
    }

    // Find the FIRST terminal tool call. Subsequent terminal calls in the
    // same response are warn-logged + ignored (review decision #21).
    const terminalCalls = toolUses.filter(tu => tu.name === terminal.name)
    if (terminalCalls.length > 1) {
      console.warn(
        `[agent-loop] Duplicate terminal tool call(s) ignored — keeping first ` +
        `(run=${opts.runId}, count=${terminalCalls.length})`,
      )
    }
    const terminalCall = terminalCalls[0]

    // Mid-tool max_tokens stop: tool_use blocks may be truncated/incomplete
    // and unusable. Fail loudly rather than try to recover.
    if (response.stop_reason === 'max_tokens' && !terminalCall) {
      const errMsg = 'agent ran out of output tokens mid-tool-use'
      opts.emit({ type: 'error', runId: opts.runId, errorClass: 'MaxTokensMidTool', message: errMsg })
      return finalize('failed', undefined, 'MaxTokensMidTool', errMsg)
    }

    if (terminalCall) {
      // Validate terminal input via the registered tool's Zod schema.
      //
      //   ┌──────────────────────────────────────────────────────────────┐
      //   │  SUCCESS path:                                                │
      //   │   • Dispatch any same-turn NON-terminal tool_uses BEFORE      │
      //   │     returning. Their side effects (e.g. cite_source persist) │
      //   │     must commit even though the conversation is ending — the │
      //   │     model issued them deliberately.                           │
      //   │   • Return finalize('success', terminal.input).               │
      //   │                                                                │
      //   │  FAILURE path (Zod validation):                                │
      //   │   • Push a tool_result with is_error: true so the model sees  │
      //   │     the validation error and can correct on the next          │
      //   │     iteration (e.g. add the missing sourceUrl for a web      │
      //   │     evidence row).                                            │
      //   │   • Also dispatch same-turn non-terminal tool_uses — Anthropic│
      //   │     requires a tool_result for every tool_use in the prior   │
      //   │     assistant message.                                        │
      //   │   • Continue the loop. Bounded by maxIterations.              │
      //   └──────────────────────────────────────────────────────────────┘
      const dispatch = await terminal.dispatch(terminalCall.input, opts.ctx)

      // Helper used by both paths. Skips the terminal tool_use itself.
      const dispatchSameTurnNonTerminals = async (): Promise<ToolResultBlockParam[]> => {
        const out: ToolResultBlockParam[] = []
        for (const tu of toolUses) {
          if (tu.id === terminalCall.id) continue
          const otherTool = registry.get(tu.name)
          if (!otherTool) continue
          if (opts.signal.aborted) break
          const r = await otherTool.dispatch(tu.input, opts.ctx)
          out.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
            is_error: !!r.errorClass,
          })
        }
        return out
      }

      if (!dispatch.errorClass) {
        // Commit any same-turn non-terminal side effects before ending.
        // Results are NOT threaded to a next iteration (we return below);
        // we only care that the handlers ran. Skip the helper entirely when
        // the terminal was the only tool_use, avoiding wasted iteration.
        if (toolUses.length > 1) {
          await dispatchSameTurnNonTerminals()
        }
        return finalize('success', terminalCall.input)
      }

      const errMsg = `terminal tool '${terminal.name}' input invalid: ${JSON.stringify(dispatch.output)}`
      opts.emit({ type: 'tool_error', runId: opts.runId, toolUseId: terminalCall.id, message: errMsg })

      const toolResults: ToolResultBlockParam[] = [{
        type: 'tool_result',
        tool_use_id: terminalCall.id,
        content: errMsg,
        is_error: true,
      }]
      toolResults.push(...(await dispatchSameTurnNonTerminals()))

      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: toolResults })
      continue
    }

    // Dispatch each non-terminal tool. Build tool_result blocks for the next user turn.
    const toolResults: ToolResultBlockParam[] = []
    for (const tu of toolUses) {
      if (opts.signal.aborted) {
        opts.emit({ type: 'aborted', runId: opts.runId })
        return finalize('aborted', undefined)
      }

      const tool = registry.get(tu.name)
      if (!tool) {
        const err = `unknown tool: ${tu.name}`
        opts.emit({ type: 'tool_error', runId: opts.runId, toolUseId: tu.id, message: err })
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ error: err }), is_error: true })
        continue
      }

      // Web-search budget check (count search-named web tools BEFORE dispatch).
      const isWebSearch = tool.category === 'web' && /search/i.test(tu.name)
      if (isWebSearch && webSearchCount >= opts.limits.webSearches) {
        const err = `web_search cap ${opts.limits.webSearches} reached`
        opts.emit({
          type: 'cap_exceeded',
          runId: opts.runId,
          cap: 'web_searches',
          limit: opts.limits.webSearches,
          used: webSearchCount,
        })
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ error: err }), is_error: true })
        continue
      }
      if (isWebSearch) webSearchCount += 1

      opts.emit({ type: 'tool_call', runId: opts.runId, toolUseId: tu.id, name: tu.name, input: tu.input })
      const dispatch = await tool.dispatch(tu.input, opts.ctx)
      toolCallCount += 1

      if (dispatch.errorClass) {
        opts.emit({
          type: 'tool_error',
          runId: opts.runId,
          toolUseId: tu.id,
          message: typeof dispatch.output === 'string' ? dispatch.output : JSON.stringify(dispatch.output),
        })
      } else {
        opts.emit({
          type: 'tool_result_summary',
          runId: opts.runId,
          toolUseId: tu.id,
          summary: summarize(tu.name, dispatch.output),
          bytes: dispatch.bytes,
          truncated: dispatch.truncated,
          ms: dispatch.ms,
        })
      }

      // Aggressive pre-truncation: cap tool_result content at 4k chars before
      // it enters `messages`. Cumulative load is bounded by design.
      let serialized = typeof dispatch.output === 'string'
        ? dispatch.output
        : JSON.stringify(dispatch.output)
      if (serialized.length > TOOL_RESULT_PRE_TRUNC_CHARS) {
        serialized = serialized.slice(0, TOOL_RESULT_PRE_TRUNC_CHARS) + '\n[…truncated]'
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: serialized,
        is_error: !!dispatch.errorClass,
      })
    }

    // Stitch this turn into the message history for the next iteration.
    messages.push({ role: 'assistant', content: response.content })
    messages.push({ role: 'user', content: toolResults })
  }

  // Iteration cap exhausted.
  opts.emit({
    type: 'cap_exceeded',
    runId: opts.runId,
    cap: 'iterations',
    limit: opts.limits.iterations,
    used: iterations,
  })
  return finalize('cap_exceeded', undefined, 'CapExceeded', `iteration cap ${opts.limits.iterations} reached`)

  // ── helpers (closures over loop state) ──
  function finalize(
    status: AgentRunResult['status'],
    terminalInput: unknown,
    errorClass?: string,
    errorMessage?: string,
  ): AgentRunResult {
    // Cost math factors all four token streams at their Anthropic-published
    // rates. cache_read at 0.1× input, cache_creation at 1.25× input.
    // For pre-caching runs (no cache fields), both totals are 0 and this
    // reduces to the original (input × in + output × out) formula.
    const cost =
      (inputTokensTotal * pricing.inputPerM +
        cacheReadTokensTotal * pricing.inputPerM * 0.1 +
        cacheCreateTokensTotal * pricing.inputPerM * 1.25 +
        outputTokensTotal * pricing.outputPerM) / 1_000_000
    if (status === 'success') {
      opts.emit({
        type: 'done',
        runId: opts.runId,
        versionId: '',                               // filled by IPC handler post-persist
        durationMs: Date.now() - start,
        inputTokens: inputTokensTotal,
        outputTokens: outputTokensTotal,
        costEstimateUsd: cost,
        toolCallCount,
      })
    }
    return {
      status,
      terminalToolInput: terminalInput,
      iterations,
      inputTokensTotal,
      outputTokensTotal,
      cacheReadTokensTotal,
      cacheCreateTokensTotal,
      costEstimateUsd: cost,
      toolCallCount,
      webSearchCount,
      durationMs: Date.now() - start,
      errorClass,
      errorMessage,
    }
  }
}

// ─── retry policy ────────────────────────────────────────────────────────

interface AnthropicLikeError extends Error {
  status?: number
  headers?: Record<string, string | undefined>
}

async function callWithRetry(
  client: Anthropic,
  params: Parameters<Anthropic['messages']['create']>[0],
  signal: AbortSignal,
): Promise<Message> {
  let attempts5xx = 0
  let attempts429 = 0
  while (true) {
    try {
      // The Anthropic SDK accepts `signal` via request options (second arg).
      return (await client.messages.create(params, { signal } as never)) as Message
    } catch (rawErr) {
      if (signal.aborted) throw rawErr
      const err = rawErr as AnthropicLikeError
      const status = err.status

      // 401 / other auth errors → fail fast, no retry
      if (status === 401 || status === 403) throw err

      // 429 → backoff per Retry-After up to MAX_RETRY_429 times
      if (status === 429) {
        if (attempts429 >= MAX_RETRY_429) throw err
        attempts429 += 1
        const retryAfterMs = parseRetryAfter(err.headers?.['retry-after']) ?? DEFAULT_RETRY_AFTER_MS
        await sleepWithAbort(retryAfterMs, signal)
        continue
      }

      // 5xx or network/timeout → retry once
      const isRetriable5xx = (status !== undefined && status >= 500 && status < 600) ||
        err.name === 'APIConnectionError' ||
        err.name === 'APIConnectionTimeoutError'
      if (isRetriable5xx && attempts5xx < MAX_RETRY_5XX) {
        attempts5xx += 1
        await sleepWithAbort(RETRY_5XX_BACKOFF_MS, signal)
        continue
      }

      // Anything else: bubble up.
      throw err
    }
  }
}

function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null
  const seconds = Number.parseFloat(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  // HTTP-date is theoretically allowed in Retry-After but Anthropic uses seconds.
  return null
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// ─── context-budget helpers ──────────────────────────────────────────────

const TOOL_RESULT_OLDER_PLACEHOLDER = '[…tool result from earlier turn omitted to fit context]'

/**
 * Walk `messages` and replace tool_result block content with a fixed-size
 * placeholder when the containing turn is older than SUMMARIZE_OLDER_THAN_TURNS.
 * `iterationsCompleted` is the number of completed iterations BEFORE this call;
 * each agent turn appends one assistant + one user message. Only tool_result
 * blocks inside user messages are summarized (not the initial user message).
 *
 * This is independent of token-budget guarantees — it bounds cumulative
 * tool_result mass so the budget rarely needs to be a panic-stop.
 */
function summarizeOlderTurns(messages: MessageParam[], iterationsCompleted: number): MessageParam[] {
  if (iterationsCompleted <= SUMMARIZE_OLDER_THAN_TURNS + 1) return messages

  // Find the index of the initial user message (always [0]). The user-tool-result
  // messages are at indices 2, 4, 6, ... (after [user, assistant, user, assistant, user, ...]).
  // Equivalently: every user message after [0] is a tool-result message.
  // Keep tool_results in the most recent SUMMARIZE_OLDER_THAN_TURNS user-tool-result messages.
  const toolResultIndices: number[] = []
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')) {
      toolResultIndices.push(i)
    }
  }
  const cutoffCount = toolResultIndices.length - SUMMARIZE_OLDER_THAN_TURNS
  if (cutoffCount <= 0) return messages

  const olderIndices = new Set(toolResultIndices.slice(0, cutoffCount))
  return messages.map((m, i) => {
    if (!olderIndices.has(i)) return m
    if (m.role !== 'user' || !Array.isArray(m.content)) return m
    const newContent = m.content.map(b => {
      if (b.type !== 'tool_result') return b
      return {
        type: 'tool_result' as const,
        tool_use_id: b.tool_use_id,
        content: TOOL_RESULT_OLDER_PLACEHOLDER,
        is_error: b.is_error,
      }
    })
    return { ...m, content: newContent }
  })
}

// ─── small utilities ────────────────────────────────────────────────────

function getInputTokens(usage: Usage): number {
  // Sum input + cache_creation + cache_read; Anthropic counts cached input
  // separately but they all consume context window space.
  return (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
}

function summarize(toolName: string, output: unknown): string {
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if ('error' in obj) return `${toolName} → error: ${truncate(String(obj.error), 80)}`
    if (Array.isArray(obj.results)) return `${toolName} → ${obj.results.length} results`
    const len = JSON.stringify(obj).length
    return `${toolName} → ${len} bytes`
  }
  if (typeof output === 'string') return `${toolName} → ${output.length} chars`
  return `${toolName} → ok`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
